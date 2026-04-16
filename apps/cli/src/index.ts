import { pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { AgentLocalClient } from '@openhermit/sdk';

import { parseChatCliArgs } from './args.js';
import { parseSlashCommand } from './commands.js';
import { formatSessionList } from './formatting.js';
import { readRuntimeState, readWorkspaceRoot } from './runtime-files.js';
import { listCliSessions, selectStartupSession } from './sessions.js';
import { parseSseFrames, waitForAssistantTurn, streamAssistantTurn } from './sse.js';
import { runTuiChatLoop } from './tui/index.js';

export {
  parseChatCliArgs,
  parseSlashCommand,
  formatSessionList,
  parseSseFrames,
  selectStartupSession,
  streamAssistantTurn,
  waitForAssistantTurn,
};

export const main = async (): Promise<void> => {
  const options = parseChatCliArgs(process.argv.slice(2));
  const runtimeState = await readRuntimeState(options.agentId);
  const workspaceRoot = await readWorkspaceRoot(options.agentId);
  const port = String(runtimeState.http_api.port);
  const token = runtimeState.http_api.token;
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
    workspaceRoot,
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
