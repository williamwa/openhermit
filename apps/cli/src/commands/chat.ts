import type { Command } from 'commander';

import { listCliSessions, selectStartupSession } from '../sessions.js';
import { runTuiChatLoop } from '../tui/index.js';
import { createGateway, resolveGatewayUrl, handleError } from './shared.js';

export const registerChatCommand = (program: Command): void => {
  program
    .command('chat')
    .description('Interactive TUI chat with an agent')
    .option('--agent-id <id>', 'Agent to connect to', process.env.OPENHERMIT_AGENT_ID ?? 'main')
    .option('--session <sessionId>', 'Resume a specific session')
    .option('--resume', 'Resume the most recent CLI session')
    .action(async (opts: { agentId: string; session?: string; resume?: boolean }) => {
      try {
        if (opts.resume && opts.session) {
          console.error('Cannot use --resume together with --session.');
          process.exit(1);
        }

        const gateway = createGateway();
        const client = gateway.agent(opts.agentId);

        const agents = await gateway.listAgents();
        const agentInfo = agents.find((a) => a.agentId === opts.agentId);
        const workspaceRoot = agentInfo?.workspaceDir ?? process.cwd();

        const initialSessions = await listCliSessions(client);
        const startupSession = selectStartupSession(
          {
            ...(opts.session ? { sessionId: opts.session } : {}),
            ...(opts.resume ? { resume: opts.resume } : {}),
          },
          initialSessions,
        );

        await runTuiChatLoop({
          client,
          token: process.env.OPENHERMIT_TOKEN ?? '',
          agentId: opts.agentId,
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
