import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { internalStateFiles } from '@openhermit/shared';
import { SqliteInternalStateStore, CURRENT_SCHEMA_VERSION, standaloneScope } from '@openhermit/store';

import { createSecurityFixture } from './helpers.js';

test('SqliteInternalStateStore bootstraps per-agent state.sqlite with schema version', async (t) => {
  const { security } = await createSecurityFixture(t);

  const store = SqliteInternalStateStore.open(security.stateFilePath);

  try {
    assert.equal(store.databasePath, security.stateFilePath);
    assert.equal(store.getSchemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.equal(existsSync(security.stateFilePath), true);
  } finally {
    store.close();
  }
});

test('SqliteInternalStateStore creates tables with agent_id and composite keys', async (t) => {
  const { security } = await createSecurityFixture(t);

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());

  // Verify sessions has composite PK (agent_id, session_id)
  const sessionColumns = store.rawDatabase
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name: string; pk: number }>;
  const sessionPks = sessionColumns.filter((c) => c.pk > 0).map((c) => c.name);
  assert.deepEqual(sessionPks, ['agent_id', 'session_id']);

  // Verify session_messages has agent_id column
  const msgColumns = store.rawDatabase
    .prepare(`PRAGMA table_info(session_messages)`)
    .all() as Array<{ name: string }>;
  const msgColumnNames = msgColumns.map((c) => c.name);
  assert.ok(msgColumnNames.includes('agent_id'));

  // Verify memories has composite PK (agent_id, memory_key)
  const memColumns = store.rawDatabase
    .prepare(`PRAGMA table_info(memories)`)
    .all() as Array<{ name: string; pk: number }>;
  const memPks = memColumns.filter((c) => c.pk > 0).map((c) => c.name);
  assert.deepEqual(memPks, ['agent_id', 'memory_key']);
});

test('SqliteInternalStateStore supports basic CRUD with FK integrity', async (t) => {
  const { security } = await createSecurityFixture(t);

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());

  // Create a session
  await store.sessions.upsert(standaloneScope, {
    sessionId: 's1',
    source: { kind: 'cli', interactive: true },
    createdAt: '2026-01-01T00:00:00Z',
    lastActivityAt: '2026-01-01T00:00:00Z',
    messageCount: 0,
  });

  const sessions = await store.sessions.list(standaloneScope);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionId, 's1');

  // Append a message (FK to session)
  await store.messages.appendLogEntry(standaloneScope, 's1', {
    ts: '2026-01-01T00:00:00Z',
    role: 'user',
    content: 'hello',
  });

  const messages = await store.messages.listHistoryMessages(standaloneScope, 's1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, 'hello');

  // Write and read memory
  const entry = await store.memories.add(standaloneScope, { id: 'test-key', content: 'remember this' });
  assert.equal(entry.content, 'remember this');
  const readBack = await store.memories.get(standaloneScope, 'test-key');
  assert.equal(readBack?.content, 'remember this');
});

test('AgentSecurity exposes per-agent internal state paths outside the workspace', async (t) => {
  const { security, root } = await createSecurityFixture(t);

  assert.match(security.stateFilePath, new RegExp(`${internalStateFiles.sqlite.replace('.', '\\.')}$`));
  assert.match(security.runtimeFilePath, new RegExp(`${internalStateFiles.runtime.replace('.', '\\.')}$`));
  assert.match(security.configFilePath, new RegExp(`${internalStateFiles.config.replace('.', '\\.')}$`));
  assert.equal(security.stateFilePath.startsWith(root), false);
  assert.equal(security.runtimeFilePath.startsWith(root), false);
  assert.equal(security.configFilePath.startsWith(root), false);
});
