import { Cron } from 'croner';
import type { ScheduleRecord, ScheduleStore, StoreScope } from '@openhermit/store';

export interface SchedulerHost {
  openSession(sessionId: string, source: { kind: string; interactive: boolean }): Promise<void>;
  postMessage(sessionId: string, text: string): Promise<void>;
  postSystemMessage(sessionId: string, text: string): Promise<void>;
}

const TICK_INTERVAL_MS = 15_000;
const BACKOFF_STEPS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export class Scheduler {
  private cronJobs = new Map<string, Cron>();
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private running = new Set<string>();
  private stopped = false;

  constructor(
    private readonly scope: StoreScope,
    private readonly store: ScheduleStore,
    private readonly host: SchedulerHost,
  ) {}

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

  private registerCron(schedule: ScheduleRecord, now: Date): void {
    try {
      const job = new Cron(schedule.cronExpression!, { timezone: 'UTC' }, () => {
        void this.executeJob(schedule.scheduleId);
      });

      // Compute and persist next run time
      const next = job.nextRun();
      if (next) {
        void this.store.markRun(this.scope, schedule.scheduleId, next.toISOString()).catch(() => {});
      }

      this.cronJobs.set(schedule.scheduleId, job);
    } catch {
      // Invalid cron expression — mark as failed
      void this.store.markRun(this.scope, schedule.scheduleId, null, 'invalid cron expression').catch(() => {});
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;

    const now = new Date().toISOString();
    const due = await this.store.listDue(this.scope, now);

    for (const schedule of due) {
      if (schedule.type === 'once') {
        void this.executeJob(schedule.scheduleId);
      }
      // cron jobs are handled by croner timers, but tick catches missed runs
      if (schedule.type === 'cron' && !this.cronJobs.has(schedule.scheduleId)) {
        void this.executeJob(schedule.scheduleId);
      }
    }
  }

  private async executeJob(scheduleId: string): Promise<void> {
    if (this.stopped) return;

    // Concurrency: skip if already running
    if (this.running.has(scheduleId)) return;

    const schedule = await this.store.get(this.scope, scheduleId);
    if (!schedule || schedule.status !== 'active') return;

    // Check concurrency policy
    if (schedule.policy.concurrency === 'skip' || !schedule.policy.concurrency) {
      if (this.running.has(scheduleId)) return;
    }

    this.running.add(scheduleId);

    const sessionId = this.resolveSessionId(schedule);

    let prompt = schedule.prompt;
    if (schedule.delivery.kind === 'session' && schedule.delivery.sessionId) {
      prompt += `\n\nWhen done, send the result to session "${schedule.delivery.sessionId}" using session_send.`;
      if (schedule.delivery.summaryOnly) {
        prompt += ' Send only a brief summary, not the full output.';
      }
    }

    // Log the run start
    const run = await this.store.startRun(this.scope, scheduleId, sessionId, prompt);

    try {
      await this.host.openSession(sessionId, { kind: 'schedule', interactive: false });
      await this.host.postMessage(sessionId, prompt);

      // Compute next run for cron
      let nextRunAt: string | null = null;
      if (schedule.type === 'cron') {
        const cronJob = this.cronJobs.get(scheduleId);
        const next = cronJob?.nextRun();
        nextRunAt = next ? next.toISOString() : null;
      }

      await this.store.markRun(this.scope, scheduleId, nextRunAt);
      await this.store.finishRun(this.scope, run.id, 'completed');

      // Mark once-type as completed
      if (schedule.type === 'once') {
        await this.store.update(this.scope, scheduleId, { status: 'completed' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.store.finishRun(this.scope, run.id, 'failed', message);

      // Compute next run with backoff
      let nextRunAt: string | null = null;
      if (schedule.type === 'cron') {
        const backoffMs = BACKOFF_STEPS[Math.min(schedule.consecutiveErrors, BACKOFF_STEPS.length - 1)]!;
        const cronJob = this.cronJobs.get(scheduleId);
        const naturalNext = cronJob?.nextRun()?.getTime() ?? 0;
        const backoffNext = Date.now() + backoffMs;
        nextRunAt = new Date(Math.max(naturalNext, backoffNext)).toISOString();
      }

      await this.store.markRun(this.scope, scheduleId, nextRunAt, message);

      // Deliver failure notification if configured
      if (schedule.delivery.kind === 'session' && schedule.delivery.sessionId) {
        try {
          await this.host.openSession(schedule.delivery.sessionId, { kind: 'schedule', interactive: false });
          await this.host.postSystemMessage(
            schedule.delivery.sessionId,
            `Schedule "${scheduleId}" failed: ${message}`,
          );
        } catch {
          // Best-effort failure notification
        }
      }
    } finally {
      this.running.delete(scheduleId);
    }
  }

  private resolveSessionId(schedule: ScheduleRecord): string {
    switch (schedule.sessionMode.kind) {
      case 'dedicated':
        return `schedule:${schedule.scheduleId}`;
      case 'ephemeral':
        return `schedule:${schedule.scheduleId}:${Date.now()}`;
      case 'target':
        return schedule.sessionMode.targetSessionId ?? `schedule:${schedule.scheduleId}`;
      default:
        return `schedule:${schedule.scheduleId}`;
    }
  }
}
