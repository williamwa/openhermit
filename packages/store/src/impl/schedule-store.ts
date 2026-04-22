import { randomUUID } from 'node:crypto';

import { PrismaClient } from '../generated/prisma/index.js';

import type { ScheduleStore } from '../interfaces.js';
import type {
  ScheduleCreateInput,
  ScheduleDelivery,
  SchedulePolicy,
  ScheduleRecord,
  ScheduleRunRecord,
  ScheduleRunStatus,
  ScheduleStatus,
  ScheduleType,
  ScheduleUpdateInput,
  StoreScope,
} from '../types.js';

export class DbScheduleStore implements ScheduleStore {
  constructor(private readonly prisma: PrismaClient) {}

  static async open(databaseUrl?: string): Promise<DbScheduleStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    return new DbScheduleStore(prisma);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async create(scope: StoreScope, input: ScheduleCreateInput): Promise<ScheduleRecord> {
    const now = new Date().toISOString();
    const scheduleId = input.scheduleId ?? randomUUID().slice(0, 8);
    const delivery: ScheduleDelivery = input.delivery ?? { kind: 'silent' };
    const policy = input.policy ?? {};

    const nextRunAt = input.type === 'once' ? (input.runAt ?? null) : null;

    const row = await this.prisma.schedule.create({
      data: {
        agentId: scope.agentId,
        scheduleId,
        type: input.type,
        status: 'active',
        cronExpression: input.cronExpression ?? null,
        runAt: input.runAt ?? null,
        prompt: input.prompt,
        sessionMode: JSON.stringify({ kind: 'dedicated' }),
        deliveryJson: JSON.stringify(delivery),
        policyJson: JSON.stringify(policy),
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
        nextRunAt,
        runCount: 0,
        consecutiveErrors: 0,
      },
    });

    return this.rowToRecord(row);
  }

  async get(scope: StoreScope, scheduleId: string): Promise<ScheduleRecord | undefined> {
    const row = await this.prisma.schedule.findUnique({
      where: { agentId_scheduleId: { agentId: scope.agentId, scheduleId } },
    });
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  async list(scope: StoreScope, options?: { status?: string }): Promise<ScheduleRecord[]> {
    const rows = await this.prisma.schedule.findMany({
      where: {
        agentId: scope.agentId,
        ...(options?.status ? { status: options.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.rowToRecord(r));
  }

  async listDue(scope: StoreScope, now: string): Promise<ScheduleRecord[]> {
    const rows = await this.prisma.schedule.findMany({
      where: {
        agentId: scope.agentId,
        status: 'active',
        nextRunAt: { lte: now },
      },
    });
    return rows.map((r) => this.rowToRecord(r));
  }

  async update(scope: StoreScope, scheduleId: string, input: ScheduleUpdateInput): Promise<ScheduleRecord> {
    const now = new Date().toISOString();
    const data: Record<string, unknown> = { updatedAt: now };

    if (input.status !== undefined) data.status = input.status;
    if (input.cronExpression !== undefined) data.cronExpression = input.cronExpression;
    if (input.runAt !== undefined) data.runAt = input.runAt;
    if (input.prompt !== undefined) data.prompt = input.prompt;
    if (input.delivery !== undefined) data.deliveryJson = JSON.stringify(input.delivery);
    if (input.policy !== undefined) data.policyJson = JSON.stringify(input.policy);

    const row = await this.prisma.schedule.update({
      where: { agentId_scheduleId: { agentId: scope.agentId, scheduleId } },
      data,
    });
    return this.rowToRecord(row);
  }

  async delete(scope: StoreScope, scheduleId: string): Promise<void> {
    await this.prisma.schedule.delete({
      where: { agentId_scheduleId: { agentId: scope.agentId, scheduleId } },
    }).catch(() => undefined);
  }

  async markRun(scope: StoreScope, scheduleId: string, nextRunAt: string | null, error?: string): Promise<void> {
    const now = new Date().toISOString();
    if (error) {
      await this.prisma.schedule.update({
        where: { agentId_scheduleId: { agentId: scope.agentId, scheduleId } },
        data: {
          lastRunAt: now,
          nextRunAt,
          consecutiveErrors: { increment: 1 },
          lastError: error,
          updatedAt: now,
        },
      });
    } else {
      await this.prisma.schedule.update({
        where: { agentId_scheduleId: { agentId: scope.agentId, scheduleId } },
        data: {
          lastRunAt: now,
          nextRunAt,
          runCount: { increment: 1 },
          consecutiveErrors: 0,
          lastError: null,
          updatedAt: now,
        },
      });
    }
  }

  async startRun(scope: StoreScope, scheduleId: string, sessionId: string, prompt: string): Promise<ScheduleRunRecord> {
    const now = new Date().toISOString();
    const row = await this.prisma.scheduleRun.create({
      data: {
        agentId: scope.agentId,
        scheduleId,
        status: 'running',
        sessionId,
        prompt,
        startedAt: now,
      },
    });
    return this.runRowToRecord(row);
  }

  async finishRun(scope: StoreScope, runId: number, status: 'completed' | 'failed', error?: string): Promise<ScheduleRunRecord> {
    const now = new Date().toISOString();
    const existing = await this.prisma.scheduleRun.findUnique({ where: { id: runId } });
    const startedAt = existing?.startedAt ?? now;
    const durationMs = new Date(now).getTime() - new Date(startedAt).getTime();

    const row = await this.prisma.scheduleRun.update({
      where: { id: runId },
      data: {
        status,
        finishedAt: now,
        durationMs,
        ...(error ? { error } : {}),
      },
    });
    return this.runRowToRecord(row);
  }

  async listRuns(scope: StoreScope, scheduleId: string, limit = 20): Promise<ScheduleRunRecord[]> {
    const rows = await this.prisma.scheduleRun.findMany({
      where: { agentId: scope.agentId, scheduleId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.runRowToRecord(r));
  }

  private runRowToRecord(row: {
    id: number;
    agentId: string;
    scheduleId: string;
    status: string;
    sessionId: string | null;
    prompt: string;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    error: string | null;
  }): ScheduleRunRecord {
    return {
      id: row.id,
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      status: row.status as ScheduleRunStatus,
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      prompt: row.prompt,
      startedAt: row.startedAt,
      ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
      ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private rowToRecord(row: {
    agentId: string;
    scheduleId: string;
    type: string;
    status: string;
    cronExpression: string | null;
    runAt: string | null;
    prompt: string;
    sessionMode: string;
    deliveryJson: string;
    policyJson: string;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
    lastRunAt: string | null;
    nextRunAt: string | null;
    runCount: number;
    consecutiveErrors: number;
    lastError: string | null;
  }): ScheduleRecord {
    return {
      agentId: row.agentId,
      scheduleId: row.scheduleId,
      type: row.type as ScheduleType,
      status: row.status as ScheduleStatus,
      ...(row.cronExpression ? { cronExpression: row.cronExpression } : {}),
      ...(row.runAt ? { runAt: row.runAt } : {}),
      prompt: row.prompt,
      delivery: JSON.parse(row.deliveryJson) as ScheduleDelivery,
      policy: JSON.parse(row.policyJson) as SchedulePolicy,
      ...(row.createdBy ? { createdBy: row.createdBy } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.lastRunAt ? { lastRunAt: row.lastRunAt } : {}),
      ...(row.nextRunAt ? { nextRunAt: row.nextRunAt } : {}),
      runCount: row.runCount,
      consecutiveErrors: row.consecutiveErrors,
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  }
}
