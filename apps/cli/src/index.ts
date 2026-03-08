import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';

import { AgentLocalClient } from '@openhermit/sdk';
import { runtimeFiles } from '@openhermit/shared';

import { HELP_TEXT } from './constants.js';
import { parseChatCliArgs, resolveWorkspaceRoot } from './args.js';
import { parseSlashCommand } from './commands.js';
import { formatSessionList } from './formatting.js';
import { readRuntimeValue } from './runtime-files.js';
import {
  createCliSessionSpec,
  createSessionId,
  findCliSession,
  listCliSessions,
  selectStartupSession,
} from './sessions.js';
import { parseSseFrames, waitForAssistantTurn } from './sse.js';

export {
  parseChatCliArgs,
  resolveWorkspaceRoot,
  parseSlashCommand,
  formatSessionList,
  parseSseFrames,
  selectStartupSession,
  waitForAssistantTurn,
};

export const main = async (): Promise<void> => {
  const options = parseChatCliArgs(process.argv.slice(2));
  const port = await readRuntimeValue(options.workspaceRoot, runtimeFiles.apiPort);
  const token = await readRuntimeValue(options.workspaceRoot, runtimeFiles.apiToken);
  const client = new AgentLocalClient({
    baseUrl: `http://127.0.0.1:${port}`,
    token,
  });
  const knownEventIds = new Map<string, number>();
  const initialSessions = await listCliSessions(client);
  const startupSession = selectStartupSession(options, initialSessions);
  let currentSessionId = startupSession.sessionId;

  await client.openSession(createCliSessionSpec(currentSessionId));
  knownEventIds.set(currentSessionId, startupSession.lastEventId);

  stdout.write(`Connected to agent ${options.agentId}\n`);
  stdout.write(`Workspace: ${options.workspaceRoot}\n`);
  stdout.write(`Session: ${currentSessionId}\n`);
  if (options.resume && startupSession.resumed) {
    stdout.write('[session] Resumed most recent CLI session\n');
  }
  stdout.write('Type /help for commands.\n\n');

  const rl = createInterface({
    input: stdin,
    output: stdout,
  });

  try {
    while (true) {
      const input = (await rl.question('you> ')).trim();

      if (!input) {
        continue;
      }

      const command = parseSlashCommand(input);

      if (command) {
        if (command.type === 'exit') {
          break;
        }

        if (command.type === 'help') {
          stdout.write(`${HELP_TEXT}\n\n`);
          continue;
        }

        if (command.type === 'new') {
          currentSessionId = createSessionId();
          await client.openSession(createCliSessionSpec(currentSessionId));
          knownEventIds.set(currentSessionId, 0);
          stdout.write(`[session] Switched to ${currentSessionId}\n\n`);
          continue;
        }

        if (command.type === 'sessions') {
          const sessions = await listCliSessions(client);
          stdout.write(`${formatSessionList(sessions, currentSessionId)}\n\n`);
          continue;
        }

        if (command.type === 'resume') {
          const existing = await findCliSession(client, command.sessionId);

          if (!existing) {
            stderr.write(`[error] CLI session not found: ${command.sessionId}\n\n`);
            continue;
          }

          currentSessionId = existing.sessionId;
          await client.openSession(createCliSessionSpec(currentSessionId));
          knownEventIds.set(
            currentSessionId,
            Math.max(
              knownEventIds.get(currentSessionId) ?? 0,
              existing.lastEventId,
            ),
          );
          stdout.write(`[session] Resumed ${currentSessionId}\n\n`);
          continue;
        }
      }

      stdout.write('agent> ');
      const currentLastEventId = knownEventIds.get(currentSessionId) ?? 0;
      await client.postMessage(currentSessionId, { text: input });
      const nextEventId = await waitForAssistantTurn(
        client,
        token,
        currentSessionId,
        currentLastEventId,
        {
          onApprovalRequired: async () => {
            const answer = await rl.question('Approve? [y/N]: ');
            const approved = answer.trim().toLowerCase() === 'y';
            stdout.write(approved ? '[approved]\n' : '[denied]\n');
            return approved;
          },
        },
      );
      knownEventIds.set(currentSessionId, nextEventId);
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
