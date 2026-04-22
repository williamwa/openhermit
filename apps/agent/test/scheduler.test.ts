import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ScheduleRecord, ScheduleRunRecord, ScheduleStore, StoreScope } from '@openhermit/store';

import { Scheduler, type SchedulerHost } from '../src/core/scheduler.js';

// ── Helpers ────────────────────────────────────────────────────────

const scope: StoreScope = { agentId: 'test-agent' };

const makeRecord = (overrides: Partial<ScheduleRecord> = {}): ScheduleRecord => ({
  agentId: 'test-agent',
  scheduleId: 'sched-1',
  type: 'cron',
  status: 'active',
  cronExpression: '0 9 * * *',
  prompt: 'do something',
  delivery: { kind: 'silent' },
  policy: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  runCount: 0,
  consecutiveErrors: 0,
  ...overrides,
});

const makeRunRecord = (overrides: Partial<ScheduleRunRecord> = {}): ScheduleRunRecord => ({
  id: 1,
  agentId: 'test-agent',
  scheduleId: 'sched-1',
  sessionId: 'schedule:sched-1',
  prompt: 'do something',
  status: 'running',
  startedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const createMockStore = (overrides: Partial<ScheduleStore> = {}): ScheduleStore => ({
  create: async (_scope, input) => makeRecord(input as Partial<ScheduleRecord>),
  get: async (_scope, id) => makeRecord({ scheduleId: id }),
  list: async () => [],
  listDue: async () => [],
  update: async (_scope, id, input) => makeRecord({ scheduleId: id, ...(input as Partial<ScheduleRecord>) }),
  delete: async () => {},
  markRun: async () => {},
  startRun: async () => makeRunRecord(),
  finishRun: async () => makeRunRecord({ status: 'completed' }),
  listRuns: async () => [],
  ...overrides,
});

const createMockHost = (overrides: Partial<SchedulerHost> = {}): SchedulerHost => ({
  openSession: async () => {},
  postMessage: async () => {},
  postSystemMessage: async () => {},
  deactivateSession: async () => {},
  ...overrides,
});

// ── Tests ──────────────────────────────────────────────────────────

test('Scheduler starts and stops without error', async () => {
  const store = createMockStore();
  const host = createMockHost();
  const scheduler = new Scheduler(scope, store, host);
  await scheduler.start();
  await scheduler.stop();
});

test('Scheduler reloads cron jobs from store', async (t) => {
  let listCalled = false;
  const store = createMockStore({
    list: async (_scope, opts) => {
      if (opts?.status === 'active') listCalled = true;
      return [makeRecord()];
    },
  });
  const host = createMockHost();
  const scheduler = new Scheduler(scope, store, host);
  await scheduler.start();
  assert.equal(listCalled, true);
  await scheduler.stop();
});

test('Scheduler tick executes due "once" jobs', async (t) => {
  const calls: string[] = [];
  let updateArgs: { id: string; input: Record<string, unknown> } | undefined;

  const onceSchedule = makeRecord({
    scheduleId: 'once-1',
    type: 'once',
    runAt: '2026-01-01T00:00:00.000Z',
  });

  const store = createMockStore({
    listDue: async () => [onceSchedule],
    get: async (_scope, id) => id === 'once-1' ? onceSchedule : undefined,
    update: async (_scope, id, input) => {
      updateArgs = { id, input: input as Record<string, unknown> };
      return makeRecord({ scheduleId: id, ...(input as Partial<ScheduleRecord>) });
    },
  });

  const host = createMockHost({
    openSession: async (sessionId) => { calls.push(`open:${sessionId}`); },
    postMessage: async (sessionId, text) => { calls.push(`msg:${sessionId}:${text}`); },
    deactivateSession: async (sessionId) => { calls.push(`deactivate:${sessionId}`); },
  });

  const scheduler = new Scheduler(scope, store, host);
  await scheduler.start();

  // Trigger tick manually by accessing the private method via any cast
  await (scheduler as any).tick();

  // Give async executeJob time to complete
  await new Promise((r) => setTimeout(r, 100));

  assert.ok(calls.some((c) => c === 'open:schedule:once-1'), 'should open session with schedule:scheduleId');
  assert.ok(calls.some((c) => c.startsWith('msg:schedule:once-1:')), 'should post message');
  assert.ok(updateArgs?.input.status === 'completed', 'once job should be marked completed');
  assert.ok(calls.some((c) => c === 'deactivate:schedule:once-1'), 'once job should deactivate session');

  await scheduler.stop();
});

test('Scheduler tick skips already-running jobs', async (t) => {
  let execCount = 0;

  const onceSchedule = makeRecord({
    scheduleId: 'once-2',
    type: 'once',
    runAt: '2026-01-01T00:00:00.000Z',
  });

  // Make openSession hang to simulate long-running job
  const store = createMockStore({
    listDue: async () => [onceSchedule],
    get: async (_scope, id) => id === 'once-2' ? onceSchedule : undefined,
  });

  const host = createMockHost({
    openSession: async () => {
      execCount++;
      await new Promise((r) => setTimeout(r, 500));
    },
  });

  const scheduler = new Scheduler(scope, store, host);
  await scheduler.start();

  // Fire tick twice quickly
  void (scheduler as any).tick();
  await new Promise((r) => setTimeout(r, 50));
  await (scheduler as any).tick();

  await new Promise((r) => setTimeout(r, 600));

  assert.equal(execCount, 1, 'second tick should skip already-running job');
  await scheduler.stop();
});

test('Scheduler executeJob appends delivery prompt when delivery.kind === session', async (t) => {
  let postedMessage = '';
  const schedule = makeRecord({
    scheduleId: 'deliver-1',
    delivery: { kind: 'session', sessionId: 'target-sess' },
  });

  const store = createMockStore({
    get: async () => schedule,
    list: async () => [],
  });

  const host = createMockHost({
    postMessage: async (_sid, text) => { postedMessage = text; },
  });

  const scheduler = new Scheduler(scope, store, host);
  await (scheduler as any).executeJob('deliver-1');

  assert.ok(postedMessage.includes('session_send'), 'prompt should mention session_send for delivery');
  assert.ok(postedMessage.includes('target-sess'), 'prompt should include target session ID');
});

test('Scheduler executeJob handles errors with backoff', async (t) => {
  let markRunError: string | undefined;
  const schedule = makeRecord({
    scheduleId: 'err-1',
    type: 'cron',
    consecutiveErrors: 2,
  });

  const store = createMockStore({
    get: async () => schedule,
    list: async () => [],
    markRun: async (_scope, _id, _next, error) => { markRunError = error; },
    finishRun: async () => makeRunRecord({ status: 'failed' }),
  });

  const host = createMockHost({
    openSession: async () => { throw new Error('connection failed'); },
  });

  const scheduler = new Scheduler(scope, store, host);
  await (scheduler as any).executeJob('err-1');

  assert.equal(markRunError, 'connection failed');
});

test('Session ID is always schedule:${scheduleId}', async (t) => {
  let openedSessionId = '';
  const schedule = makeRecord({ scheduleId: 'sid-test' });

  const store = createMockStore({
    get: async () => schedule,
    list: async () => [],
  });

  const host = createMockHost({
    openSession: async (sid) => { openedSessionId = sid; },
  });

  const scheduler = new Scheduler(scope, store, host);
  await (scheduler as any).executeJob('sid-test');

  assert.equal(openedSessionId, 'schedule:sid-test');
});

test('Scheduler passes createdBy as userId to openSession', async (t) => {
  let passedUserId: string | undefined;
  const schedule = makeRecord({ scheduleId: 'user-1', createdBy: 'user-abc' });

  const store = createMockStore({
    get: async () => schedule,
    list: async () => [],
  });

  const host = createMockHost({
    openSession: async (_sid, _source, userId) => { passedUserId = userId; },
  });

  const scheduler = new Scheduler(scope, store, host);
  await (scheduler as any).executeJob('user-1');

  assert.equal(passedUserId, 'user-abc');
});

test('Once-type schedule deactivates session after completion', async () => {
  let deactivatedId = '';
  const schedule = makeRecord({
    scheduleId: 'once-deact',
    type: 'once',
    runAt: '2026-01-01T00:00:00.000Z',
  });

  const store = createMockStore({
    get: async () => schedule,
    list: async () => [],
  });

  const host = createMockHost({
    deactivateSession: async (sid) => { deactivatedId = sid; },
  });

  const scheduler = new Scheduler(scope, store, host);
  await (scheduler as any).executeJob('once-deact');

  assert.equal(deactivatedId, 'schedule:once-deact');
});

test('Cron-type schedule does NOT deactivate session after execution', async () => {
  let deactivated = false;
  const schedule = makeRecord({
    scheduleId: 'cron-nodeact',
    type: 'cron',
    cronExpression: '0 9 * * *',
  });

  const store = createMockStore({
    get: async () => schedule,
    list: async () => [],
  });

  const host = createMockHost({
    deactivateSession: async () => { deactivated = true; },
  });

  const scheduler = new Scheduler(scope, store, host);
  await (scheduler as any).executeJob('cron-nodeact');

  assert.equal(deactivated, false, 'cron jobs should not deactivate session');
});
