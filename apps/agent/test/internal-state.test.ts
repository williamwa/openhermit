import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { internalStateFiles } from '@openhermit/shared';
import { SqliteInternalStateStore, standaloneScope } from '@openhermit/store';

import { initializeInternalStateDatabase, openInternalStateDatabase } from '../src/internal-state/sqlite.js';
import { createSecurityFixture } from './helpers.js';

test('initializeInternalStateDatabase bootstraps per-agent state.sqlite with schema version', async (t) => {
  const { security } = await createSecurityFixture(t);

  const database = initializeInternalStateDatabase(security.stateFilePath);

  try {
    assert.equal(database.databasePath, security.stateFilePath);
    assert.equal(database.getSchemaVersion(), 4);
    assert.equal(existsSync(security.stateFilePath), true);
  } finally {
    database.close();
  }
});

test('initializeInternalStateDatabase removes unused legacy tables', async (t) => {
  const { security } = await createSecurityFixture(t);

  const database = initializeInternalStateDatabase(security.stateFilePath);
  const rawDatabase = openInternalStateDatabase(security.stateFilePath);

  try {
    const row = rawDatabase
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN (
             'identity_inputs',
             'identity_state',
             'approvals',
             'bindings',
             'schedules',
             'schedule_runs'
           )`,
      )
      .all() as Array<{ name: string }>;

    assert.deepEqual(row, []);
  } finally {
    rawDatabase.close();
    database.close();
  }
});

test('initializeInternalStateDatabase migrates a version 3 database to version 4', async (t) => {
  const { security } = await createSecurityFixture(t);

  const legacyDatabase = new DatabaseSync(security.stateFilePath);
  legacyDatabase.exec(
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;`,
  );
  legacyDatabase
    .prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', '3')`)
    .run();
  legacyDatabase.exec(
    `CREATE TABLE IF NOT EXISTS approvals (
      approval_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      payload_json TEXT NOT NULL
    ) STRICT;`,
  );
  legacyDatabase.exec(
    `CREATE TABLE IF NOT EXISTS bindings (
      binding_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_platform TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;`,
  );
  legacyDatabase.close();

  const database = initializeInternalStateDatabase(security.stateFilePath);
  const rawDatabase = openInternalStateDatabase(security.stateFilePath);

  try {
    assert.equal(database.getSchemaVersion(), 4);

    const row = rawDatabase
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('approvals', 'bindings')`,
      )
      .all() as Array<{ name: string }>;

    assert.deepEqual(row, []);
  } finally {
    rawDatabase.close();
    database.close();
  }
});

test('SqliteInternalStateStore migrates a v4 database to v5 and FK integrity holds', async (t) => {
  const { security } = await createSecurityFixture(t);

  // Create a v4 database using the old code path.
  const legacyDb = initializeInternalStateDatabase(security.stateFilePath);
  assert.equal(legacyDb.getSchemaVersion(), 4);
  legacyDb.close();

  // Seed some data so the migration has rows to move.
  const raw = new DatabaseSync(security.stateFilePath);
  raw.exec(`
    INSERT INTO sessions(session_id, source_kind, interactive, created_at, last_activity_at, message_count)
    VALUES ('s1', 'cli', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
  `);
  raw.exec(`
    INSERT INTO session_events(session_id, ts, event_type, payload_json)
    VALUES ('s1', '2026-01-01T00:00:00Z', 'session_started', '{}');
  `);
  raw.exec(`
    INSERT INTO session_messages(session_id, ts, role, content)
    VALUES ('s1', '2026-01-01T00:00:00Z', 'user', 'hello');
  `);
  raw.exec(`
    INSERT INTO memories(memory_key, memory_kind, content, updated_at)
    VALUES ('main', 'main', 'remember this', '2026-01-01T00:00:00Z');
  `);
  raw.close();

  // Open with the new store — triggers migration v5.
  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());

  assert.equal(store.getSchemaVersion(), 5);

  // Verify migrated data is accessible.
  const sessions = await store.sessions.list(standaloneScope);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.sessionId, 's1');

  const messages = await store.messages.listHistoryMessages(standaloneScope, 's1');
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.content, 'hello');

  const mainMemory = await store.memories.getMainMemory(standaloneScope);
  assert.equal(mainMemory, 'remember this');

  // Verify inserts work (FK integrity holds for new writes).
  await store.messages.appendLogEntry(standaloneScope, 's1', {
    ts: '2026-01-02T00:00:00Z',
    role: 'assistant',
    content: 'world',
  });

  const updatedMessages = await store.messages.listHistoryMessages(standaloneScope, 's1');
  assert.equal(updatedMessages.length, 2);
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
