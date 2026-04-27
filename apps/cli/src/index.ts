import { pathToFileURL } from 'node:url';
import { stderr } from 'node:process';

import { GatewayClient } from '@openhermit/sdk';

import { parseChatCliArgs } from './args.js';
import { parseSlashCommand } from './commands.js';
import { formatSessionList } from './formatting.js';
import { maybeClaimOwnership } from './ownership.js';
import { waitForAssistantTurn, streamAssistantTurn } from './sse.js';
import { createCliSessionSpec, listCliSessions, selectStartupSession } from './sessions.js';
import { runTuiChatLoop } from './tui/index.js';

export {
  parseChatCliArgs,
  parseSlashCommand,
  formatSessionList,
  selectStartupSession,
  streamAssistantTurn,
  waitForAssistantTurn,
};

const resolveGatewayUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.OPENHERMIT_GATEWAY_URL) return env.OPENHERMIT_GATEWAY_URL;
  const port = env.GATEWAY_PORT ?? env.PORT ?? '4000';
  return `http://127.0.0.1:${port}`;
};

export const main = async (): Promise<void> => {
  const options = parseChatCliArgs(process.argv.slice(2));
  const gatewayUrl = resolveGatewayUrl();
  const token = process.env.OPENHERMIT_TOKEN ?? '';

  const gateway = new GatewayClient({ baseUrl: gatewayUrl, token });
  const client = gateway.agent(options.agentId);

  // Fetch workspace root from gateway agent info.
  const agents = await gateway.listAgents();
  const agentInfo = agents.find((a) => a.agentId === options.agentId);
  const workspaceRoot = agentInfo?.workspaceDir ?? process.cwd();

  const initialSessions = await listCliSessions(client);
  const startupSession = selectStartupSession(options, initialSessions);

  await client.openSession(createCliSessionSpec(startupSession.sessionId));
  await maybeClaimOwnership({
    agentId: options.agentId,
    gatewayUrl,
    token,
    client,
    sessionId: startupSession.sessionId,
  });

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
