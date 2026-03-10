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

  const out = options?.output;
  const abortSignal = options?.signal;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let nextLastEventId = lastEventId;
  let sawDelta = false;
  let sawAgentEnd = false;
  let wasCancelled = false;
  let lastActivityTs = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const onAbort =
    abortSignal &&
    (() => {
      wasCancelled = true;
      reader.cancel().catch(() => undefined);
    });

  if (abortSignal?.aborted) {
    await reader.cancel().catch(() => undefined);
    throw new Error('Assistant turn cancelled.');
  }

  // In non-TUI mode, give a simple hint that the agent is still running,
  // and periodically repeat it if there's a long pause between events.
  if (!out) {
    stdout.write('[thinking...]\n');
    heartbeatTimer = setInterval(() => {
      if (sawAgentEnd) return;
      const now = Date.now();
      // Only emit another heartbeat if we've been idle for a while.
      if (now - lastActivityTs >= 10_000) {
        stdout.write('[thinking...]\n');
        lastActivityTs = now;
      }
    }, 2_000);
  }

  try {
    if (onAbort) {
      abortSignal!.addEventListener('abort', onAbort);
    }

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

        // Any new frame counts as "activity" from the agent.
        lastActivityTs = Date.now();

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

          let approved = false;

          if (options?.onApprovalRequired) {
            if (out?.onApprovalPrompt) {
              out.onApprovalPrompt(toolName, payload.args);
            } else {
              stdout.write(`\n[approval required] ${toolName}`);
              if (payload.args !== undefined) {
                const formatted = formatDebugValue(payload.args);
                if (formatted) {
                  stdout.write(formatted.includes('\n') ? `\n${formatted}` : ` ${formatted}`);
                }
              }
              stdout.write('\n');
            }
            approved = await options.onApprovalRequired(toolName, toolCallId, payload.args);
          } else {
            if (out) {
              out.onError?.('[approval required] No approval handler configured — auto-denying.');
            } else {
              stdout.write('[approval required] No approval handler configured — auto-denying.\n');
            }
          }

          await client.submitApproval(sessionId, { toolCallId, approved });
          continue;
        }

        if (frame.event === 'tool_requested') {
          if (out?.onToolRequested) {
            out.onToolRequested(String(payload.tool ?? 'unknown'), payload.args);
          } else {
            writeToolRequested(String(payload.tool ?? 'unknown'), payload.args);
          }
          continue;
        }

        if (frame.event === 'tool_started') {
          if (out?.onToolStarted) {
            out.onToolStarted(String(payload.tool ?? 'unknown'), payload.args);
          } else {
            writeToolStarted(String(payload.tool ?? 'unknown'), payload.args);
          }
          continue;
        }

        if (frame.event === 'tool_result') {
          if (out?.onToolResult) {
            out.onToolResult(
              String(payload.tool ?? 'unknown'),
              Boolean(payload.isError),
              payload.text,
              payload.details,
            );
          } else {
            writeToolResult(
              String(payload.tool ?? 'unknown'),
              Boolean(payload.isError),
              payload.text,
              payload.details,
            );
          }
          continue;
        }

        if (frame.event === 'text_delta') {
          const text = String(payload.text ?? '');
          if (out?.onTextDelta) {
            out.onTextDelta(text);
          } else {
            stdout.write(text);
          }
          sawDelta = true;
          continue;
        }

        if (frame.event === 'text_final') {
          const text = String(payload.text ?? '');
          if (out?.onTextFinal) {
            out.onTextFinal(text, sawDelta);
          } else {
            if (!sawDelta) {
              stdout.write(text);
            }
            stdout.write('\n');
          }
          continue;
        }

        if (frame.event === 'error') {
          const message = String(payload.message ?? 'Unknown error');
          if (out?.onError) {
            out.onError(message);
          } else {
            stderr.write(`\n[error] ${message}\n`);
          }
          continue;
        }

        if (frame.event === 'agent_end') {
          if (!out) {
            stdout.write('[done]\n');
          }
          // Don't return immediately – process the rest of this batch first so that
          // any trailing text_final events in the same chunk are still handled.
          sawAgentEnd = true;
          continue;
        }
      }

      if (sawAgentEnd) {
        return nextLastEventId;
      }
    }
  } finally {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    if (onAbort && abortSignal) {
      abortSignal.removeEventListener('abort', onAbort);
    }
    await reader.cancel().catch(() => undefined);
  }

  if (wasCancelled || abortSignal?.aborted) {
    throw new Error('Assistant turn cancelled.');
  }

  throw new Error('SSE stream ended before the assistant produced a final event.');
};
