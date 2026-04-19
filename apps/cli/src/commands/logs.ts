import type { Command } from 'commander';

import { resolveGatewayUrl, handleError } from './shared.js';

interface LogEntry {
  timestamp: string;
  message: string;
}

export const registerLogsCommand = (program: Command): void => {
  program
    .command('logs')
    .description('View gateway logs')
    .option('-n, --lines <count>', 'Number of log lines to fetch', '50')
    .option('-f, --follow', 'Poll for new log entries')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { lines: string; follow?: boolean; json?: boolean }) => {
      const url = resolveGatewayUrl();
      const token = process.env.OPENHERMIT_TOKEN ?? '';
      const lines = Number.parseInt(opts.lines, 10) || 50;

      const fetchLogs = async (count: number): Promise<LogEntry[]> => {
        const response = await fetch(`${url}/api/admin/logs?lines=${count}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          throw new Error(`Failed to fetch logs: ${response.status} ${response.statusText}`);
        }
        return (await response.json()) as LogEntry[];
      };

      const printEntries = (entries: LogEntry[]): void => {
        for (const entry of entries) {
          if (opts.json) {
            console.log(JSON.stringify(entry));
          } else {
            const ts = entry.timestamp.slice(11, 19); // HH:MM:SS
            console.log(`${ts}  ${entry.message}`);
          }
        }
      };

      try {
        const entries = await fetchLogs(lines);
        printEntries(entries);

        if (opts.follow) {
          let lastTimestamp = entries.length > 0
            ? entries[entries.length - 1]!.timestamp
            : '';

          const poll = async (): Promise<void> => {
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
              try {
                const fresh = await fetchLogs(50);
                const newer = lastTimestamp
                  ? fresh.filter((e) => e.timestamp > lastTimestamp)
                  : fresh;
                if (newer.length > 0) {
                  printEntries(newer);
                  lastTimestamp = newer[newer.length - 1]!.timestamp;
                }
              } catch {
                // Gateway may have gone away — keep trying.
              }
            }
          };

          await poll();
        }
      } catch (error) {
        handleError(error);
      }
    });
};
