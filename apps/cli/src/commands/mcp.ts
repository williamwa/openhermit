import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerMcpCommand = (program: Command): void => {
  const mcp = program
    .command('mcp')
    .description('Manage MCP servers');

  const resolveTarget = (opts: { agent?: string; all?: boolean }): string => {
    if (opts.agent && opts.all) {
      console.error('Pass either --agent <id> or --all, not both.');
      process.exit(1);
    }
    if (opts.all) return '*';
    if (opts.agent) return opts.agent;
    console.error('Pass --agent <id> or --all.');
    process.exit(1);
  };
  const targetLabel = (target: string): string =>
    target === '*' ? 'all agents' : `agent ${target}`;

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
    .description('Enable an MCP server. Targets one agent (--agent) or every agent (--all).')
    .argument('<mcpServerId>', 'MCP server ID')
    .option('--agent <id>', 'Agent ID')
    .option('--all', 'Apply to every agent (writes a wildcard assignment row)')
    .action(async (mcpServerId: string, opts: { agent?: string; all?: boolean }) => {
      try {
        const target = resolveTarget(opts);
        const gateway = createGateway();
        await gateway.enableMcpServer(mcpServerId, target);
        console.log(`Enabled MCP server ${mcpServerId} for ${targetLabel(target)}.`);
      } catch (error) {
        handleError(error);
      }
    });

  mcp
    .command('disable')
    .description('Disable an MCP server. Targets one agent (--agent) or every agent (--all).')
    .argument('<mcpServerId>', 'MCP server ID')
    .option('--agent <id>', 'Agent ID')
    .option('--all', 'Apply to every agent (removes the wildcard assignment row)')
    .action(async (mcpServerId: string, opts: { agent?: string; all?: boolean }) => {
      try {
        const target = resolveTarget(opts);
        const gateway = createGateway();
        await gateway.disableMcpServer(mcpServerId, target);
        console.log(`Disabled MCP server ${mcpServerId} for ${targetLabel(target)}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
