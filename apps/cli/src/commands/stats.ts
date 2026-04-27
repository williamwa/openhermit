import type { Command } from 'commander';

import { createGateway, handleError } from './shared.js';

const formatBytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

const formatUptime = (seconds: number): string => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

export const registerStatsCommand = (program: Command): void => {
  program
    .command('stats')
    .description('Show gateway runtime stats (uptime, memory, counts)')
    .action(async () => {
      try {
        const gateway = createGateway();
        const stats = await gateway.getAdminStats();
        console.log('System');
        console.log(`  Uptime:        ${formatUptime(stats.uptime)}`);
        console.log(`  RSS Memory:    ${formatBytes(stats.memory.rss)}`);
        console.log(`  Heap Used:     ${formatBytes(stats.memory.heapUsed)}`);
        console.log(`  Heap Total:    ${formatBytes(stats.memory.heapTotal)}`);
        console.log('');
        console.log('Data');
        console.log(`  Running Agents: ${stats.agents.running}`);
        console.log(`  Users:          ${stats.counts.users}`);
        console.log(`  Sessions:       ${stats.counts.sessions}`);
        console.log(`  Session Events: ${stats.counts.sessionEvents}`);
      } catch (error) {
        handleError(error);
      }
    });
};
