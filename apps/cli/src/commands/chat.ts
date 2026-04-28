import type { Command } from 'commander';

import { maybeClaimOwnership, registerCliIdentity } from '../ownership.js';
import { createCliSessionSpec, listCliSessions, selectStartupSession } from '../sessions.js';
import { runTuiChatLoop } from '../tui/index.js';
import { createGateway, resolveGatewayUrl, handleError } from './shared.js';

export const registerChatCommand = (program: Command): void => {
  program
    .command('chat')
    .description('Interactive TUI chat with an agent')
    .option('--agent <id>', 'Agent to connect to', process.env.OPENHERMIT_AGENT_ID ?? 'main')
    .option('--session <sessionId>', 'Resume a specific session')
    .option('--resume', 'Resume the most recent CLI session')
    .action(async (opts: { agent: string; session?: string; resume?: boolean }) => {
      try {
        if (opts.resume && opts.session) {
          console.error('Cannot use --resume together with --session.');
          process.exit(1);
        }

        const gateway = createGateway();
        const client = gateway.agent(opts.agent);

        const agents = await gateway.listAgents();
        const agentInfo = agents.find((a) => a.agentId === opts.agent);
        const workspaceRoot = agentInfo?.workspaceDir ?? process.cwd();

        const initialSessions = await listCliSessions(client);
        const startupSession = selectStartupSession(
          {
            ...(opts.session ? { sessionId: opts.session } : {}),
            ...(opts.resume ? { resume: opts.resume } : {}),
          },
          initialSessions,
        );

        const token = process.env.OPENHERMIT_TOKEN ?? '';
        const gatewayUrl = resolveGatewayUrl();

        // Step 1: register CLI identity at the gateway (global user + agent
        // membership). Step 2: open session so the runner picks up the
        // resolved role. Step 3: ownership prompt if no owner yet.
        await registerCliIdentity({ agentId: opts.agent, gatewayUrl, token });
        await client.openSession(createCliSessionSpec(startupSession.sessionId));
        await maybeClaimOwnership({
          agentId: opts.agent,
          gatewayUrl,
          token,
          client,
          sessionId: startupSession.sessionId,
        });

        await runTuiChatLoop({
          client,
          token,
          agentId: opts.agent,
          workspaceRoot,
          startupSession,
          resumeFlag: opts.resume ?? false,
        });
      } catch (error) {
        handleError(error);
      }
    });

  // Make `chat` the default command when no subcommand is given.
  program.action(() => {
    program.outputHelp();
  });
};
