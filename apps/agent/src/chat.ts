import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';

import { AgentLocalClient } from '@cloudmind/sdk';
import { runtimeFiles } from '@cloudmind/shared';

interface ChatCliOptions {
  agentId: string;
  workspaceRoot: string;
  sessionId?: string;
}

interface SseFrame {
  id?: number;
  event: string;
  data: string;
}

const HELP_TEXT = [
  'Usage: npm run chat:agent -- [--agent-id <id>] [--workspace <path>] [--session <sessionId>]',
  '',
  'Commands:',
  '  /exit   End the chat session',
  '  /help   Show this help message',
].join('\n');

const parseFlagValue = (
  argv: string[],
  index: number,
  flag: string,
): string => {
  const value = argv[index + 1];

  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
};

export const resolveWorkspaceRoot = (
  cwd: string,
  agentId: string,
  explicitWorkspaceRoot?: string,
): string =>
  explicitWorkspaceRoot
    ? path.resolve(cwd, explicitWorkspaceRoot)
    : path.join(cwd, '.cloudmind-dev', agentId);

export const parseChatCliArgs = (
  argv: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ChatCliOptions => {
  let agentId = env.CLOUDMIND_AGENT_ID ?? 'agent-dev';
  let explicitWorkspaceRoot = env.CLOUDMIND_WORKSPACE_ROOT;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--agent-id') {
      agentId = parseFlagValue(argv, index, '--agent-id');
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      explicitWorkspaceRoot = parseFlagValue(argv, index, '--workspace');
      index += 1;
      continue;
    }

    if (arg === '--session') {
      sessionId = parseFlagValue(argv, index, '--session');
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      throw new Error(HELP_TEXT);
    }

    throw new Error(`Unknown argument: ${arg}\n\n${HELP_TEXT}`);
  }

  return {
    agentId,
    workspaceRoot: resolveWorkspaceRoot(cwd, agentId, explicitWorkspaceRoot),
    ...(sessionId ? { sessionId } : {}),
  };
};

const createSessionId = (): string =>
  `cli:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

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

const readRuntimeValue = async (
  workspaceRoot: string,
  relativePath: string,
): Promise<string> => {
  const filePath = path.join(workspaceRoot, relativePath);
  return (await fs.readFile(filePath, 'utf8')).trim();
};

const formatDebugValue = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  const compact = JSON.stringify(value);

  if (compact && compact.length <= 120) {
    return compact;
  }

  return JSON.stringify(value, null, 2);
};

const writeToolRequested = (tool: string, args: unknown): void => {
  const formattedArgs = formatDebugValue(args);

  if (!formattedArgs) {
    stdout.write(`\n[tool requested] ${tool}\n`);
    return;
  }

  if (formattedArgs.includes('\n')) {
    stdout.write(`\n[tool requested] ${tool}\n${formattedArgs}\n`);
    return;
  }

  stdout.write(`\n[tool requested] ${tool} ${formattedArgs}\n`);
};

const writeToolStarted = (tool: string, args: unknown): void => {
  const formattedArgs = formatDebugValue(args);

  if (!formattedArgs) {
    stdout.write(`\n[tool] ${tool}\n`);
    return;
  }

  if (formattedArgs.includes('\n')) {
    stdout.write(`\n[tool] ${tool}\n${formattedArgs}\n`);
    return;
  }

  stdout.write(`\n[tool] ${tool} ${formattedArgs}\n`);
};

const writeToolResult = (
  tool: string,
  isError: boolean,
  text: unknown,
  details: unknown,
): void => {
  const label = isError ? '[tool error]' : '[tool result]';
  const body = details !== undefined ? formatDebugValue(details) : formatDebugValue(text);

  if (!body) {
    stdout.write(`${label} ${tool}\n`);
    return;
  }

  if (body.includes('\n')) {
    stdout.write(`${label} ${tool}\n${body}\n`);
    return;
  }

  stdout.write(`${label} ${tool} ${body}\n`);
};

export interface AssistantTurnOptions {
  /**
   * Called when the agent requires user approval before executing a tool.
   * Return true to approve, false to deny.
   * When undefined, approval requests are auto-denied.
   */
  onApprovalRequired?: (
    toolName: string,
    toolCallId: string,
    args: unknown,
  ) => Promise<boolean>;
}

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

export const main = async (): Promise<void> => {
  const options = parseChatCliArgs(process.argv.slice(2));
  const port = await readRuntimeValue(options.workspaceRoot, runtimeFiles.apiPort);
  const token = await readRuntimeValue(options.workspaceRoot, runtimeFiles.apiToken);
  const sessionId = options.sessionId ?? createSessionId();
  const client = new AgentLocalClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  });

  await client.openSession({
    sessionId,
    source: {
      kind: 'cli',
      interactive: true,
    },
  });

  stdout.write(`Connected to agent ${options.agentId}\n`);
  stdout.write(`Workspace: ${options.workspaceRoot}\n`);
  stdout.write(`Session: ${sessionId}\n`);
  stdout.write('Type /help for commands.\n\n');

  const rl = createInterface({
    input: stdin,
    output: stdout,
  });
  let lastEventId = 0;

  try {
    while (true) {
      const input = (await rl.question('you> ')).trim();

      if (!input) {
        continue;
      }

      if (input === '/exit') {
        break;
      }

      if (input === '/help') {
        stdout.write(`${HELP_TEXT}\n\n`);
        continue;
      }

      stdout.write('agent> ');
      await client.postMessage(sessionId, { text: input });
      lastEventId = await waitForAssistantTurn(client, token, sessionId, lastEventId, {
        onApprovalRequired: async (toolName, toolCallId, args) => {
          // The approval prompt was already printed by waitForAssistantTurn.
          // We just need to ask y/n here.
          const answer = await rl.question('Approve? [y/N]: ');
          const approved = answer.trim().toLowerCase() === 'y';
          stdout.write(approved ? '[approved]\n' : '[denied]\n');
          return approved;
        },
      });
      stdout.write('\n');
    }
  } finally {
    rl.close();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
