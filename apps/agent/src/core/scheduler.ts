import { Cron } from 'croner';
import type { ScheduleRecord, ScheduleStore, StoreScope } from '@openhermit/store';

export interface SchedulerHost {
  openSession(sessionId: string, source: { kind: string; interactive: boolean }, userId?: string): Promise<void>;
  postMessage(sessionId: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
  postSystemMessage(sessionId: string, text: string): Promise<void>;
  deactivateSession(sessionId: string): Promise<void>;
}

export interface SchedulerOptions {
  /** Receives runtime warnings (invalid cron, persistence failures, ...). Defaults to a no-op. */
  log?: (message: string) => void;
}

const TICK_INTERVAL_MS = 15_000;
const BACKOFF_STEPS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export class Scheduler {
  private cronJobs = new Map<string, Cron>();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private stopped = false;
  private readonly log: (message: string) => void;

  constructor(
    private readonly scope: StoreScope,
    private readonly store: ScheduleStore,
    private readonly host: SchedulerHost,
    options: SchedulerOptions = {},
  ) {
    this.log = options.log ?? (() => {});
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.reload();
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    for (const [, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();
  }

  async reload(): Promise<void> {
    for (const [, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();

    const schedules = await this.store.list(this.scope, { status: 'active' });
    const now = new Date();

    for (const schedule of schedules) {
      if (schedule.type === 'cron' && schedule.cronExpression) {
        this.registerCron(schedule, now);
      }
    }
  }

  private registerCron(schedule: ScheduleRecord, _now: Date): void {
    try {
      const job = new Cron(schedule.cronExpression!, { timezone: 'UTC' }, () => {
        void this.executeJob(schedule.scheduleId);
      });

      // Compute and persist next run time
      const next = job.nextRun();
      if (next) {
        void this.store.markRun(this.scope, schedule.scheduleId, next.toISOString())
          .catch((err) => this.log(`schedule ${schedule.scheduleId}: markRun(next) failed: ${describe(err)}`));
      }

      this.cronJobs.set(schedule.scheduleId, job);
    } catch (err) {
      // Invalid cron expression — mark as failed and surface the reason.
      this.log(`schedule ${schedule.scheduleId}: invalid cron expression "${schedule.cronExpression}": ${describe(err)}`);
      void this.store.markRun(this.scope, schedule.scheduleId, null, 'invalid cron expression')
        .catch((markErr) => this.log(`schedule ${schedule.scheduleId}: markRun(invalid) failed: ${describe(markErr)}`));
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    const now = new Date().toISOString();
    let due: ScheduleRecord[];
    try {
      due = await this.store.listDue(this.scope, now);
    } catch (err) {
      this.log(`scheduler tick: listDue failed: ${describe(err)}`);
      return;
    }

    for (const schedule of due) {
      if (schedule.type === 'once') {
        void this.executeJob(schedule.scheduleId);
      }
      // cron jobs are handled by croner timers, but tick catches missed runs
      // when no in-process Cron is registered (e.g. the cron expression
      // failed to register, or a race during reload()).
      if (schedule.type === 'cron' && !this.cronJobs.has(schedule.scheduleId)) {
        void this.executeJob(schedule.scheduleId);
      }
    }
  }

  private async executeJob(scheduleId: string): Promise<void> {
    if (this.stopped) return;

    // Claim the running slot SYNCHRONOUSLY before any await, otherwise two
    // concurrent invocations (cron-callback firing + a tick-driven catch-up
    // for the same schedule, or two ticks during a slow run) can both pass
    // the `has` check before either marks the slot, ending up with the same
    // job running twice in parallel.
    if (this.running.has(scheduleId)) return;
    this.running.add(scheduleId);

    try {
      const schedule = await this.store.get(this.scope, scheduleId);
      if (!schedule || schedule.status !== 'active') return;

      const sessionId = `schedule:${schedule.scheduleId}`;

      // Build prompt with delivery context
      let prompt = schedule.prompt;
      if (schedule.delivery.kind === 'session' && schedule.delivery.sessionId) {
        prompt += `\n\n[Delivery] After completing the task, if necessary, use session_send to send the result to session "${schedule.delivery.sessionId}".`;
      }

      const run = await this.store.startRun(this.scope, scheduleId, sessionId, prompt);

      try {
        await this.host.openSession(sessionId, { kind: 'schedule', interactive: false }, schedule.createdBy ?? undefined);
        await this.host.postMessage(sessionId, prompt, {
          schedule_id: schedule.scheduleId,
          schedule_type: schedule.type,
        });

        // Compute next run for cron
        let nextRunAt: string | null = null;
        if (schedule.type === 'cron') {
          const cronJob = this.cronJobs.get(scheduleId);
          const next = cronJob?.nextRun();
          nextRunAt = next ? next.toISOString() : null;
        }

        await this.store.markRun(this.scope, scheduleId, nextRunAt);
        await this.store.finishRun(this.scope, run.id, 'completed');

        if (schedule.type === 'once') {
          await this.store.update(this.scope, scheduleId, { status: 'completed' });
          await this.host.deactivateSession(sessionId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`schedule ${scheduleId} run ${run.id}: failed: ${message}`);

        await this.store.finishRun(this.scope, run.id, 'failed', message)
          .catch((err) => this.log(`schedule ${scheduleId} run ${run.id}: finishRun failed: ${describe(err)}`));

        let nextRunAt: string | null = null;
        if (schedule.type === 'cron') {
          const backoffMs = BACKOFF_STEPS[Math.min(schedule.consecutiveErrors, BACKOFF_STEPS.length - 1)]!;
          const cronJob = this.cronJobs.get(scheduleId);
          const naturalNext = cronJob?.nextRun()?.getTime() ?? 0;
          const backoffNext = Date.now() + backoffMs;
          nextRunAt = new Date(Math.max(naturalNext, backoffNext)).toISOString();
        }

        await this.store.markRun(this.scope, scheduleId, nextRunAt, message)
          .catch((err) => this.log(`schedule ${scheduleId}: markRun(failed) failed: ${describe(err)}`));
      }
    } catch (err) {
      // Outer guard: store.get / startRun threw.
      this.log(`schedule ${scheduleId}: setup failed: ${describe(err)}`);
    } finally {
      this.running.delete(scheduleId);
    }
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
