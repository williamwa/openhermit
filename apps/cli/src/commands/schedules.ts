import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

const defaultAgentId = (): string =>
  process.env.OPENHERMIT_AGENT_ID ?? 'one';

export const registerSchedulesCommand = (program: Command): void => {
  const schedules = program
    .command('schedules')
    .description('Manage agent schedules');

  // --- list ---
  schedules
    .command('list')
    .description('List schedules for an agent')
    .option('--agent-id <id>', 'Agent ID', defaultAgentId())
    .option('--status <status>', 'Filter by status')
    .action(async (opts: { agentId: string; status?: string }) => {
      try {
        const gateway = createGateway();
        let list = (await gateway.listSchedules(opts.agentId)) as any[];

        if (opts.status) {
          list = list.filter((s: any) => s.status === opts.status);
        }

        if (list.length === 0) {
          console.log('No schedules found.');
          return;
        }

        printTable(
          list.map((s: any) => ({
            id: s.scheduleId,
            type: s.type,
            status: s.status,
            cron: s.cronExpression ?? '',
            runAt: s.runAt ?? '',
            prompt: (s.prompt.length > 50 ? s.prompt.slice(0, 50) + '…' : s.prompt),
            runs: String(s.runCount),
            nextRun: s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '',
          })),
          [
            { key: 'id', label: 'ID', width: 10 },
            { key: 'type', label: 'Type', width: 6 },
            { key: 'status', label: 'Status', width: 10 },
            { key: 'cron', label: 'Cron' },
            { key: 'prompt', label: 'Prompt' },
            { key: 'runs', label: 'Runs', width: 5 },
            { key: 'nextRun', label: 'Next Run' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  // --- create ---
  schedules
    .command('create')
    .description('Create a new schedule')
    .option('--agent-id <id>', 'Agent ID', defaultAgentId())
    .requiredOption('--type <type>', 'Schedule type (cron or once)')
    .requiredOption('--prompt <prompt>', 'Prompt to execute')
    .option('--cron <expr>', 'Cron expression (for cron type)')
    .option('--run-at <iso>', 'ISO datetime to run at (for once type)')
    .option('--id <id>', 'Custom schedule ID')
    .action(async (opts: {
      agentId: string;
      type: string;
      prompt: string;
      cron?: string;
      runAt?: string;
      id?: string;
    }) => {
      try {
        const gateway = createGateway();
        const result = await gateway.createSchedule(opts.agentId, {
          type: opts.type as 'cron' | 'once',
          prompt: opts.prompt,
          ...(opts.cron ? { cronExpression: opts.cron } : {}),
          ...(opts.runAt ? { runAt: opts.runAt } : {}),
          ...(opts.id ? { id: opts.id } : {}),
        }) as any;
        console.log(`Schedule created: ${result.scheduleId ?? result.id}`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- pause ---
  schedules
    .command('pause <scheduleId>')
    .description('Pause a schedule')
    .option('--agent-id <id>', 'Agent ID', defaultAgentId())
    .action(async (scheduleId: string, opts: { agentId: string }) => {
      try {
        const gateway = createGateway();
        await gateway.updateSchedule(opts.agentId, scheduleId, { status: 'paused' });
        console.log(`Schedule ${scheduleId} paused.`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- resume ---
  schedules
    .command('resume <scheduleId>')
    .description('Resume a paused schedule')
    .option('--agent-id <id>', 'Agent ID', defaultAgentId())
    .action(async (scheduleId: string, opts: { agentId: string }) => {
      try {
        const gateway = createGateway();
        await gateway.updateSchedule(opts.agentId, scheduleId, { status: 'active' });
        console.log(`Schedule ${scheduleId} resumed.`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- delete ---
  schedules
    .command('delete <scheduleId>')
    .description('Delete a schedule')
    .option('--agent-id <id>', 'Agent ID', defaultAgentId())
    .action(async (scheduleId: string, opts: { agentId: string }) => {
      try {
        const gateway = createGateway();
        await gateway.deleteSchedule(opts.agentId, scheduleId);
        console.log(`Schedule ${scheduleId} deleted.`);
      } catch (error) {
        handleError(error);
      }
    });

  // --- runs ---
  schedules
    .command('runs <scheduleId>')
    .description('List runs for a schedule')
    .option('--agent-id <id>', 'Agent ID', defaultAgentId())
    .option('--limit <n>', 'Max number of runs to show')
    .action(async (scheduleId: string, opts: { agentId: string; limit?: string }) => {
      try {
        const gateway = createGateway();
        const limit = opts.limit ? Number(opts.limit) : undefined;
        const runs = (await gateway.listScheduleRuns(opts.agentId, scheduleId, limit)) as any[];

        if (runs.length === 0) {
          console.log('No runs found.');
          return;
        }

        printTable(
          runs.map((r: any) => ({
            id: String(r.id),
            status: r.status,
            started: new Date(r.startedAt).toLocaleString(),
            duration: r.durationMs != null ? `${r.durationMs}ms` : '',
            error: r.error ? r.error.slice(0, 60) : '',
          })),
          [
            { key: 'id', label: 'ID', width: 6 },
            { key: 'status', label: 'Status', width: 10 },
            { key: 'started', label: 'Started' },
            { key: 'duration', label: 'Duration', width: 10 },
            { key: 'error', label: 'Error' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });
};
