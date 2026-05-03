import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError, NotFoundError } from '@openhermit/shared';

import {
  ExecBackendManager,
  createExecBackend,
  type ExecBackend,
  type BackendFactoryContext,
} from '../src/core/exec-backend.js';
import type { DockerRunner, DockerContainerManager } from '../src/core/container-manager.js';

const fakeContext: BackendFactoryContext = {
  containerManager: {} as DockerContainerManager,
  agentId: 'test-agent',
  workspaceDir: '/tmp/workspace',
};

// ── createExecBackend ────────────────────────────────────────────────────

test('createExecBackend creates a host backend', () => {
  const backend = createExecBackend({ type: 'host', id: 'host' }, fakeContext);
  assert.equal(backend.type, 'host');
  assert.equal(backend.id, 'host');
});

test('createExecBackend throws for unknown type', () => {
  assert.throws(
    () => createExecBackend({ type: 'unknown' } as any, fakeContext),
    ValidationError,
  );
});

// ── ExecBackendManager ───────────────────────────────────────────────────

const makeFakeBackend = (id: string, type = 'host'): ExecBackend => ({
  id,
  type,
  label: id,
  username: 'tester',
  agentHome: '/tmp/fake',
  ensure: async () => {},
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
  shutdown: async () => {},
});

test('ExecBackendManager throws on empty backends', () => {
  assert.throws(() => new ExecBackendManager([]), ValidationError);
});

test('ExecBackendManager uses first backend as default', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a'), makeFakeBackend('b')]);
  assert.equal(mgr.getDefault().id, 'a');
});

test('ExecBackendManager respects explicit default', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a'), makeFakeBackend('b')], 'b');
  assert.equal(mgr.getDefault().id, 'b');
});

test('ExecBackendManager throws on invalid default', () => {
  assert.throws(
    () => new ExecBackendManager([makeFakeBackend('a')], 'missing'),
    ValidationError,
  );
});

test('ExecBackendManager.get throws for unknown id', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a')]);
  assert.throws(() => mgr.get('nope'), NotFoundError);
});

test('ExecBackendManager.list returns all backends', () => {
  const mgr = new ExecBackendManager([makeFakeBackend('a'), makeFakeBackend('b')]);
  assert.equal(mgr.list().length, 2);
});

test('ExecBackendManager.fromConfig falls back to host', () => {
  const mgr = ExecBackendManager.fromConfig(undefined, fakeContext);
  assert.equal(mgr.getDefault().type, 'host');
});

test('ExecBackendManager.fromConfig auto-assigns ids', () => {
  const mgr = ExecBackendManager.fromConfig(
    { backends: [{ type: 'host' }, { type: 'host' }] },
    fakeContext,
  );
  const ids = mgr.list().map((b) => b.id);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
});

test('ExecBackendManager.shutdownAll calls all backends', async () => {
  let shutdownCount = 0;
  const backend = (): ExecBackend => ({
    ...makeFakeBackend('x'),
    id: `b-${shutdownCount++}`,
    shutdown: async () => { shutdownCount++; },
  });
  const mgr = new ExecBackendManager([backend(), backend()]);
  shutdownCount = 0;
  await mgr.shutdownAll();
  assert.equal(shutdownCount, 2);
});
