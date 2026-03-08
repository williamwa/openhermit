import { stderr, stdout } from 'node:process';

import { AgentLocalClient } from '@openhermit/sdk';

import {
  formatDebugValue,
  writeToolRequested,
  writeToolResult,
  writeToolStarted,
} from './formatting.js';
import type { AssistantTurnOptions, SseFrame } from './types.js';

export const parseSseFrames = (
  buffer: string,
): { frames: SseFrame[]; remainder: string } => {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const segments = normalized.split('\n\n');
  const remainder = segments.pop() ?? '';
  const frames: SseFrame[] = [];

  for (const segment of segments) {
    const lines = segment.split('\n');
    let event = 'message';
    let data = '';
    let id: number | undefined;

    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
        continue;
      }

      if (line.startsWith('data:')) {
        data += `${line.slice(5).trim()}\n`;
        continue;
      }

      if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice(3).trim(), 10);

        if (!Number.isNaN(parsed)) {
          id = parsed;
        }
      }
    }

    frames.push({
      ...(id !== undefined ? { id } : {}),
      event,
      data: data.replace(/\n$/, ''),
    });
  }

  return {
    frames,
    remainder,
  };
};

export const waitForAssistantTurn = async (
  client: AgentLocalClient,
  token: string,
  sessionId: string,
  lastEventId: number,
  options?: AssistantTurnOptions,
): Promise<number> => {
  const response = await fetch(client.buildEventsUrl(sessionId), {
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to open SSE stream (${response.status}): ${await response.text()}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let nextLastEventId = lastEventId;
  let sawDelta = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remainder;

      for (const frame of parsed.frames) {
        if (frame.id !== undefined && frame.id <= nextLastEventId) {
          continue;
        }

        if (frame.id !== undefined) {
          nextLastEventId = frame.id;
        }

        if (frame.event === 'ready' || frame.event === 'ping') {
          continue;
        }

        const payload =
          frame.data.length > 0
            ? (JSON.parse(frame.data) as Record<string, unknown>)
            : {};

        if (frame.event === 'tool_approval_required') {
          const toolName = String(payload.toolName ?? 'unknown');
          const toolCallId = String(payload.toolCallId ?? '');

          stdout.write(`\n[approval required] ${toolName}`);

          if (payload.args !== undefined) {
            const formatted = formatDebugValue(payload.args);

            if (formatted) {
              stdout.write(formatted.includes('\n') ? `\n${formatted}` : ` ${formatted}`);
            }
          }

          stdout.write('\n');

          let approved = false;

          if (options?.onApprovalRequired) {
            approved = await options.onApprovalRequired(toolName, toolCallId, payload.args);
          } else {
            stdout.write('[approval required] No approval handler configured — auto-denying.\n');
          }

          await client.submitApproval(sessionId, { toolCallId, approved });
          continue;
        }

        if (frame.event === 'tool_requested') {
          writeToolRequested(String(payload.tool ?? 'unknown'), payload.args);
          continue;
        }

        if (frame.event === 'tool_started') {
          writeToolStarted(String(payload.tool ?? 'unknown'), payload.args);
          continue;
        }

        if (frame.event === 'tool_result') {
          writeToolResult(
            String(payload.tool ?? 'unknown'),
            Boolean(payload.isError),
            payload.text,
            payload.details,
          );
          continue;
        }

        if (frame.event === 'text_delta') {
          stdout.write(String(payload.text ?? ''));
          sawDelta = true;
          continue;
        }

        if (frame.event === 'text_final') {
          if (!sawDelta) {
            stdout.write(String(payload.text ?? ''));
          }

          stdout.write('\n');
          continue;
        }

        if (frame.event === 'error') {
          stderr.write(`\n[error] ${String(payload.message ?? 'Unknown error')}\n`);
          continue;
        }

        if (frame.event === 'agent_end') {
          return nextLastEventId;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  throw new Error('SSE stream ended before the assistant produced a final event.');
};
