import type { Command } from 'commander';

import { resolveGatewayUrl, createGateway, handleError } from './shared.js';

export const registerStatusCommand = (program: Command): void => {
  program
    .command('status')
    .description('Show platform-wide status overview')
    .action(async () => {
      const url = resolveGatewayUrl();

      // 1. Gateway health
      let gatewayOk = false;
      try {
        const response = await fetch(`${url}/health`);
        gatewayOk = response.ok;
      } catch {
        // not reachable
      }
      console.log(`Gateway:    ${gatewayOk ? '✓ running' : '✗ not reachable'} (${url})`);

      if (!gatewayOk) {
        console.log('\nGateway is not running. Start it with: hermit gateway run');
        return;
      }

      // 2. Agents
      try {
        const gateway = createGateway();
        const agents = await gateway.listAgents();

        if (agents.length === 0) {
          console.log('Agents:     (none registered)');
        } else {
          const running = agents.filter((a) => a.status === 'running').length;
          const stopped = agents.length - running;
          console.log(`Agents:     ${agents.length} registered (${running} running, ${stopped} stopped)`);

          for (const agent of agents) {
            const icon = agent.status === 'running' ? '✓' : '○';
            const name = agent.name ? ` (${agent.name})` : '';
            console.log(`  ${icon} ${agent.agentId}${name} — ${agent.status}`);
          }
        }
      } catch (error) {
        console.log(`Agents:     ✗ failed to list (${error instanceof Error ? error.message : String(error)})`);
      }
    });
};
