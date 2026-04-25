import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerMcpCommand = (program: Command): void => {
  const mcp = program
    .command('mcp')
    .description('Manage MCP servers (use --agent "*" to target all agents)');

  mcp
    .command('list')
    .description('List all MCP servers in the registry')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = (await gateway.listMcpServers()) as any[];
        if (list.length === 0) {
          console.log('No MCP servers registered.');
          return;
        }
        printTable(
          list.map((s: any) => ({
            id: s.id,
            name: s.name ?? '',
            url: s.url ?? '',
            description: s.description
              ? (s.description.length > 50 ? s.description.slice(0, 50) + '…' : s.description)
              : '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'url', label: 'URL' },
            { key: 'description', label: 'Description' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  mcp
    .command('assignments')
    .description('List MCP server assignments')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = await gateway.listMcpAssignments();
        if (list.length === 0) {
          console.log('No MCP server assignments.');
          return;
        }
        printTable(
          list.map((a) => ({
            agentId: a.agentId,
            mcpServerId: a.mcpServerId,
            enabled: a.enabled ? 'yes' : 'no',
          })),
          [
            { key: 'agentId', label: 'Agent', width: 16 },
            { key: 'mcpServerId', label: 'MCP Server' },
            { key: 'enabled', label: 'Enabled', width: 8 },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  mcp
    .command('enable')
    .description('Enable an MCP server for an agent (use --agent "*" for all agents)')
    .argument('<mcpServerId>', 'MCP server ID')
    .requiredOption('--agent <id>', 'Agent ID, or "*" for all agents')
    .action(async (mcpServerId: string, opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        await gateway.enableMcpServer(mcpServerId, opts.agent);
        const target = opts.agent === '*' ? 'all agents' : `agent ${opts.agent}`;
        console.log(`Enabled MCP server ${mcpServerId} for ${target}.`);
      } catch (error) {
        handleError(error);
      }
    });

  mcp
    .command('disable')
    .description('Disable an MCP server for an agent (use --agent "*" for all agents)')
    .argument('<mcpServerId>', 'MCP server ID')
    .requiredOption('--agent <id>', 'Agent ID, or "*" for all agents')
    .action(async (mcpServerId: string, opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        await gateway.disableMcpServer(mcpServerId, opts.agent);
        const target = opts.agent === '*' ? 'all agents' : `agent ${opts.agent}`;
        console.log(`Disabled MCP server ${mcpServerId} for ${target}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
