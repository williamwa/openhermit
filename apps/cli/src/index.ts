import { pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { AgentLocalClient } from '@openhermit/sdk';
import { runtimeFiles } from '@openhermit/shared';

import { parseChatCliArgs, resolveWorkspaceRoot } from './args.js';
import { parseSlashCommand } from './commands.js';
import { formatSessionList } from './formatting.js';
import { readRuntimeValue } from './runtime-files.js';
import { listCliSessions, selectStartupSession } from './sessions.js';
import { parseSseFrames, waitForAssistantTurn } from './sse.js';
import { runTuiChatLoop } from './tui/index.js';

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

  const initialSessions = await listCliSessions(client);
  const startupSession = selectStartupSession(options, initialSessions);

  await runTuiChatLoop({
    client,
    token,
    agentId: options.agentId,
    workspaceRoot: options.workspaceRoot,
    startupSession,
    resumeFlag: options.resume,
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
