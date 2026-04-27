import assert from 'node:assert/strict';
import test from 'node:test';

import { DbInternalStateStore, standaloneScope } from '@openhermit/store';

import { createSecurityFixture } from './helpers.js';

test('DbInternalStateStore connects to PostgreSQL', async () => {
  const store = await DbInternalStateStore.open();
  try {
    assert.ok(store);
    assert.ok(store.sessions);
    assert.ok(store.messages);
    assert.ok(store.memories);
  } finally {
    await store.close();
  }
});

test('DbInternalStateStore supports basic CRUD with FK integrity', async (t) => {
  const store = await DbInternalStateStore.open();
  t.after(() => store.close());

  const scope = { agentId: `test-crud-${Date.now()}` };

  // Create a session
  await store.sessions.upsert(scope, {
    sessionId: 's1',
    source: { kind: 'cli', interactive: true },
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    messageCount: 0,
  });

  const sessions = await store.sessions.list(scope);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionId, 's1');

  // Append a message (FK to session)
  await store.messages.appendLogEntry(scope, 's1', {
    ts: '2026-01-01T00:00:00Z',
    role: 'user',
    content: 'hello',
  });

  const messages = await store.messages.listHistoryMessages(scope, 's1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, 'hello');

  // Write and read memory
  const entry = await store.memories.add(scope, { id: 'test-key', content: 'remember this' });
  assert.equal(entry.content, 'remember this');
  const readBack = await store.memories.get(scope, 'test-key');
  assert.equal(readBack?.content, 'remember this');
});

test('AgentSecurity rootDir lives outside the workspace', async (t) => {
  const { security, root } = await createSecurityFixture(t);

  // rootDir is where skill-mounts symlinks live; it must never be inside
  // the agent's workspace, so workspace cleanup can't blow it away.
  assert.ok(security.rootDir.length > 0);
  assert.equal(security.rootDir.startsWith(root), false);
});
