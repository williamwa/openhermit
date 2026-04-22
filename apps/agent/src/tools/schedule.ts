import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type Toolset,
  type ToolContext,
  asTextContent,
  formatJson,
  ensureAutonomyAllows,
} from './shared.js';

// ── Parameters ──────────────────────────────────────────────────────

const ScheduleListParams = Type.Object({
  status: Type.Optional(Type.String({ description: 'Filter by status: active, paused, completed, failed.' })),
});

type ScheduleListArgs = Static<typeof ScheduleListParams>;

const ScheduleCreateParams = Type.Object({
  type: Type.Union([Type.Literal('cron'), Type.Literal('once')], {
    description: 'Schedule type: "cron" for recurring, "once" for one-time.',
  }),
  prompt: Type.String({ description: 'The prompt/instruction to execute when triggered.' }),
  cron_expression: Type.Optional(Type.String({ description: 'Cron expression (required for type "cron"). e.g. "0 9 * * *" for daily at 9am UTC.' })),
  run_at: Type.Optional(Type.String({ description: 'ISO 8601 datetime for one-time execution (required for type "once").' })),
  id: Type.Optional(Type.String({ description: 'Custom schedule ID. Auto-generated if omitted.' })),
  session_mode: Type.Optional(Type.Union([
    Type.Literal('dedicated'),
    Type.Literal('ephemeral'),
    Type.Object({ target: Type.String({ description: 'Target session ID to run in.' }) }),
  ], { description: 'Session strategy. "dedicated" (default) reuses one session per job. "ephemeral" creates a new session each run. {target: sessionId} runs in a specific session.' })),
  delivery: Type.Optional(Type.Union([
    Type.Literal('silent'),
    Type.Object({
      session: Type.String({ description: 'Session ID to send results to via session_send.' }),
      summary_only: Type.Optional(Type.Boolean({ description: 'Send only a brief summary (default true).' })),
    }),
  ], { description: 'Result delivery. "silent" (default) keeps results in the job session only.' })),
  timeout_seconds: Type.Optional(Type.Number({ description: 'Maximum execution time in seconds.' })),
  model: Type.Optional(Type.String({ description: 'Override model for this job.' })),
});

type ScheduleCreateArgs = Static<typeof ScheduleCreateParams>;

const ScheduleUpdateParams = Type.Object({
  id: Type.String({ description: 'Schedule ID to update.' }),
  status: Type.Optional(Type.Union([
    Type.Literal('active'),
    Type.Literal('paused'),
  ], { description: 'Change status: "active" or "paused".' })),
  prompt: Type.Optional(Type.String({ description: 'Update the prompt.' })),
  cron_expression: Type.Optional(Type.String({ description: 'Update the cron expression.' })),
  run_at: Type.Optional(Type.String({ description: 'Update the run_at time (once type only).' })),
});

type ScheduleUpdateArgs = Static<typeof ScheduleUpdateParams>;

const ScheduleDeleteParams = Type.Object({
  id: Type.String({ description: 'Schedule ID to delete.' }),
});

type ScheduleDeleteArgs = Static<typeof ScheduleDeleteParams>;

const ScheduleRunsParams = Type.Object({
  id: Type.String({ description: 'Schedule ID to view run history for.' }),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of runs to return (default 10).' })),
});

type ScheduleRunsArgs = Static<typeof ScheduleRunsParams>;

const ScheduleTriggerParams = Type.Object({
  id: Type.String({ description: 'Schedule ID to trigger immediately.' }),
});

type ScheduleTriggerArgs = Static<typeof ScheduleTriggerParams>;

// ── Tools ───────────────────────────────────────────────────────────

const createScheduleListTool = (context: ToolContext): AgentTool<typeof ScheduleListParams> => ({
  name: 'schedule_list',
  label: 'List Schedules',
  description: 'List all scheduled jobs for this agent. Shows type, status, cron expression, next run time, and run count.',
  parameters: ScheduleListParams,
  execute: async (_toolCallId, args: ScheduleListArgs) => {
    if (!context.scheduleStore || !context.storeScope) {
      throw new ValidationError('schedule_list is unavailable: no schedule store is configured.');
    }

    const schedules = await context.scheduleStore.list(
      context.storeScope,
      args.status ? { status: args.status } : undefined,
    );

    const result = schedules.map((s) => ({
      id: s.scheduleId,
      type: s.type,
      status: s.status,
      ...(s.cronExpression ? { cron: s.cronExpression } : {}),
      ...(s.runAt ? { runAt: s.runAt } : {}),
      prompt: s.prompt.length > 100 ? `${s.prompt.slice(0, 100)}…` : s.prompt,
      sessionMode: s.sessionMode.kind,
      delivery: s.delivery.kind,
      runCount: s.runCount,
      ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}),
      ...(s.lastRunAt ? { lastRunAt: s.lastRunAt } : {}),
      ...(s.consecutiveErrors > 0 ? { consecutiveErrors: s.consecutiveErrors, lastError: s.lastError } : {}),
    }));

    return {
      content: asTextContent(
        result.length > 0
          ? formatJson(result)
          : 'No schedules found.\n',
      ),
      details: { count: result.length },
    };
  },
});

const createScheduleCreateTool = (context: ToolContext): AgentTool<typeof ScheduleCreateParams> => ({
  name: 'schedule_create',
  label: 'Create Schedule',
  description:
    'Create a new scheduled job. Use type "cron" with a cron expression for recurring tasks, '
    + 'or type "once" with a run_at time for one-time tasks. The prompt is sent to the agent when triggered.',
  parameters: ScheduleCreateParams,
  execute: async (_toolCallId, args: ScheduleCreateArgs) => {
    ensureAutonomyAllows(context.security, 'schedule_create');

    if (!context.scheduleStore || !context.storeScope) {
      throw new ValidationError('schedule_create is unavailable: no schedule store is configured.');
    }

    if (args.type === 'cron' && !args.cron_expression) {
      throw new ValidationError('cron_expression is required for type "cron".');
    }
    if (args.type === 'once' && !args.run_at) {
      throw new ValidationError('run_at is required for type "once".');
    }

    // Parse session_mode
    let sessionMode: { kind: 'dedicated' | 'ephemeral' | 'target'; targetSessionId?: string } = { kind: 'dedicated' };
    if (args.session_mode) {
      if (typeof args.session_mode === 'string') {
        sessionMode = { kind: args.session_mode };
      } else if ('target' in args.session_mode) {
        sessionMode = { kind: 'target', targetSessionId: args.session_mode.target };
      }
    }

    // Parse delivery
    let delivery: { kind: 'silent' | 'session'; sessionId?: string; summaryOnly?: boolean } = { kind: 'silent' };
    if (args.delivery) {
      if (typeof args.delivery === 'string') {
        delivery = { kind: 'silent' };
      } else if ('session' in args.delivery) {
        delivery = { kind: 'session', sessionId: args.delivery.session, summaryOnly: args.delivery.summary_only ?? true };
      }
    }

    // Parse policy
    const policy: Record<string, unknown> = {};
    if (args.timeout_seconds) policy.timeout_seconds = args.timeout_seconds;
    if (args.model) policy.model = args.model;

    const schedule = await context.scheduleStore.create(context.storeScope, {
      ...(args.id ? { scheduleId: args.id } : {}),
      type: args.type,
      ...(args.cron_expression ? { cronExpression: args.cron_expression } : {}),
      ...(args.run_at ? { runAt: args.run_at } : {}),
      prompt: args.prompt,
      sessionMode,
      delivery,
      policy,
      ...(context.currentUserId ? { createdBy: context.currentUserId } : {}),
    });

    // Notify scheduler to reload
    context.onScheduleChange?.();

    return {
      content: asTextContent(`Schedule created: ${schedule.scheduleId} (${schedule.type}, ${schedule.status})\n`),
      details: { scheduleId: schedule.scheduleId, type: schedule.type },
    };
  },
});

const createScheduleUpdateTool = (context: ToolContext): AgentTool<typeof ScheduleUpdateParams> => ({
  name: 'schedule_update',
  label: 'Update Schedule',
  description: 'Update an existing schedule. Can change status (active/paused), prompt, or cron expression.',
  parameters: ScheduleUpdateParams,
  execute: async (_toolCallId, args: ScheduleUpdateArgs) => {
    ensureAutonomyAllows(context.security, 'schedule_update');

    if (!context.scheduleStore || !context.storeScope) {
      throw new ValidationError('schedule_update is unavailable: no schedule store is configured.');
    }

    const existing = await context.scheduleStore.get(context.storeScope, args.id);
    if (!existing) {
      throw new ValidationError(`Schedule not found: ${args.id}`);
    }

    const patch: Record<string, unknown> = {};
    if (args.status !== undefined) patch.status = args.status;
    if (args.prompt !== undefined) patch.prompt = args.prompt;
    if (args.cron_expression !== undefined) patch.cronExpression = args.cron_expression;
    if (args.run_at !== undefined) patch.runAt = args.run_at;

    const updated = await context.scheduleStore.update(context.storeScope, args.id, patch);

    context.onScheduleChange?.();

    return {
      content: asTextContent(`Schedule updated: ${updated.scheduleId} (status: ${updated.status})\n`),
      details: { scheduleId: updated.scheduleId, status: updated.status },
    };
  },
});

const createScheduleDeleteTool = (context: ToolContext): AgentTool<typeof ScheduleDeleteParams> => ({
  name: 'schedule_delete',
  label: 'Delete Schedule',
  description: 'Delete a scheduled job permanently.',
  parameters: ScheduleDeleteParams,
  execute: async (_toolCallId, args: ScheduleDeleteArgs) => {
    ensureAutonomyAllows(context.security, 'schedule_delete');

    if (!context.scheduleStore || !context.storeScope) {
      throw new ValidationError('schedule_delete is unavailable: no schedule store is configured.');
    }

    const existing = await context.scheduleStore.get(context.storeScope, args.id);
    if (!existing) {
      throw new ValidationError(`Schedule not found: ${args.id}`);
    }

    await context.scheduleStore.delete(context.storeScope, args.id);

    context.onScheduleChange?.();

    return {
      content: asTextContent(`Schedule deleted: ${args.id}\n`),
      details: { scheduleId: args.id },
    };
  },
});

const createScheduleTriggerTool = (context: ToolContext): AgentTool<typeof ScheduleTriggerParams> => ({
  name: 'schedule_trigger',
  label: 'Trigger Schedule Now',
  description: 'Trigger a scheduled job immediately, regardless of its next run time. The job runs in its configured session.',
  parameters: ScheduleTriggerParams,
  execute: async (_toolCallId, args: ScheduleTriggerArgs) => {
    ensureAutonomyAllows(context.security, 'schedule_trigger');

    if (!context.scheduleStore || !context.storeScope) {
      throw new ValidationError('schedule_trigger is unavailable: no schedule store is configured.');
    }

    const existing = await context.scheduleStore.get(context.storeScope, args.id);
    if (!existing) {
      throw new ValidationError(`Schedule not found: ${args.id}`);
    }

    // Set nextRunAt to now to trigger on next tick
    const now = new Date().toISOString();
    await context.scheduleStore.update(context.storeScope, args.id, {
      status: 'active',
    });
    await context.scheduleStore.markRun(context.storeScope, args.id, now);

    context.onScheduleChange?.();

    return {
      content: asTextContent(`Schedule "${args.id}" triggered. It will execute on the next scheduler tick.\n`),
      details: { scheduleId: args.id },
    };
  },
});

const createScheduleRunsTool = (context: ToolContext): AgentTool<typeof ScheduleRunsParams> => ({
  name: 'schedule_runs',
  label: 'Schedule Run History',
  description: 'View the execution history of a scheduled job. Shows status, duration, session ID, and errors for recent runs.',
  parameters: ScheduleRunsParams,
  execute: async (_toolCallId, args: ScheduleRunsArgs) => {
    if (!context.scheduleStore || !context.storeScope) {
      throw new ValidationError('schedule_runs is unavailable: no schedule store is configured.');
    }

    const existing = await context.scheduleStore.get(context.storeScope, args.id);
    if (!existing) {
      throw new ValidationError(`Schedule not found: ${args.id}`);
    }

    const runs = await context.scheduleStore.listRuns(context.storeScope, args.id, args.limit ?? 10);

    const result = runs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      ...(r.durationMs != null ? { durationMs: r.durationMs } : {}),
      ...(r.sessionId ? { sessionId: r.sessionId } : {}),
      ...(r.error ? { error: r.error } : {}),
    }));

    return {
      content: asTextContent(
        result.length > 0
          ? formatJson(result)
          : `No runs found for schedule "${args.id}".\n`,
      ),
      details: { scheduleId: args.id, count: result.length },
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const SCHEDULE_DESCRIPTION = `\
### Schedule Management

You can create and manage scheduled jobs that run automatically at specified times.

- **Cron jobs**: Recurring tasks using cron expressions (e.g. "0 9 * * *" for daily at 9am UTC)
- **One-time jobs**: Execute once at a specified time

Each job runs in its own session and can optionally deliver results to another session.

Examples:
- "remind me tomorrow at 9am" → \`schedule_create\` with type "once"
- "check my email every hour" → \`schedule_create\` with type "cron"
- "list my schedules" → \`schedule_list\`
- "pause the email check" → \`schedule_update\` with status "paused"
- "run the email check now" → \`schedule_trigger\``;

export const createScheduleToolset = (context: ToolContext): Toolset => ({
  id: 'schedule',
  description: SCHEDULE_DESCRIPTION,
  tools: [
    createScheduleListTool(context),
    createScheduleCreateTool(context),
    createScheduleUpdateTool(context),
    createScheduleDeleteTool(context),
    createScheduleTriggerTool(context),
    createScheduleRunsTool(context),
  ],
});
