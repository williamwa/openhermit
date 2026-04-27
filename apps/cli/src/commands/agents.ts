import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerAgentsCommand = (program: Command): void => {
  const agents = program
    .command('agents')
    .description('Manage agents');

  // --- list ---
  agents
    .command('list')
    .description('List all registered agents')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = await gateway.listAgents();

        if (list.length === 0) {
          console.log('No agents registered.');
          return;
        }

        printTable(
          list.map((a) => ({
            id: a.agentId,
            name: a.name ?? '',
            status: a.status,
            workspace: a.workspaceDir ?? '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'status', label: 'Status', width: 10 },
            { key: 'workspace', label: 'Workspace' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  // --- create ---
  agents
    .command('create <agentId>')
    .description('Create a new agent')
    .option('--name <name>', 'Display name for the agent')
    .option('--workspace-dir <path>', 'Custom workspace directory')
    .option('--owner <userId>', 'Owner user ID')
    .action(async (agentId: string, opts: {
      name?: string;
      workspaceDir?: string;
      owner?: string;
    }) => {
      try {
        const gateway = createGateway();
        const result = await gateway.createAgent({
          agentId,
          ...(opts.name ? { name: opts.name } : {}),
          ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
          ...(opts.owner ? { ownerUserId: opts.owner } : {}),
        });
        console.log(`Agent created: ${result.agentId} (${result.status})`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- start ---
  agents
    .command('start <agentId>')
    .description('Start a stopped agent')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'start');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- stop ---
  agents
    .command('stop <agentId>')
    .description('Stop a running agent')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'stop');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- restart ---
  agents
    .command('restart <agentId>')
    .description('Restart an agent')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();
        const result = await gateway.manageAgent(agentId, 'restart');
        console.log(`Agent ${result.agentId}: ${result.status}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- delete ---
  agents
    .command('delete <agentId>')
    .description('Delete an agent and all its data (must be stopped first)')
    .action(async (agentId: string) => {
      try {
        const gateway = createGateway();

        const health = await gateway.agentHealth(agentId);
        if (health.status === 'running') {
          console.error(`Agent ${agentId} is still running. Stop it first with: hermit agents stop ${agentId}`);
          process.exit(1);
        }

        await gateway.deleteAgent(agentId);
        console.log(`Agent deleted: ${agentId}`);
      } catch (error) {
        handleError(error);
      }
    });
};
