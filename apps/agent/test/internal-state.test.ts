import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

test('SqliteInternalStateStore removes unused legacy tables', async (t) => {
  const { security } = await createSecurityFixture(t);

  const store = SqliteInternalStateStore.open(security.stateFilePath);

  try {
    const row = store.rawDatabase
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
    store.close();
  }
});

test('SqliteInternalStateStore migrates a version 3 database with legacy tables to latest', async (t) => {
  const { security } = await createSecurityFixture(t);

  // Build a realistic v3 database: core tables from v1/v2 + legacy tables.
  const legacyDatabase = new DatabaseSync(security.stateFilePath);
  legacyDatabase.exec('PRAGMA journal_mode = WAL;');
  legacyDatabase.exec('PRAGMA foreign_keys = ON;');
  legacyDatabase.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
  legacyDatabase.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_platform TEXT,
      interactive INTEGER NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
      description TEXT, description_source TEXT, message_count INTEGER NOT NULL DEFAULT 0,
      completed_turn_count INTEGER NOT NULL DEFAULT 0, last_summarized_history_count INTEGER NOT NULL DEFAULT 0,
      last_summarized_turn_count INTEGER NOT NULL DEFAULT 0, last_summarized_at TEXT, last_message_preview TEXT,
      working_memory TEXT, working_memory_updated_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'idle'
    ) STRICT;
  `);
  legacyDatabase.exec(`
    CREATE TABLE session_messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE) STRICT;
  `);
  legacyDatabase.exec(`
    CREATE TABLE session_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE) STRICT;
  `);
  legacyDatabase.exec(`
    CREATE TABLE episodic_checkpoints (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL,
      checkpoint_type TEXT NOT NULL, reason TEXT NOT NULL, history_from INTEGER NOT NULL,
      history_to INTEGER NOT NULL, turn_count INTEGER NOT NULL, summary TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE) STRICT;
  `);
  legacyDatabase.exec(`
    CREATE TABLE memories (memory_key TEXT PRIMARY KEY, memory_kind TEXT NOT NULL,
      content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL) STRICT;
  `);
  legacyDatabase.exec(`
    CREATE TABLE container_runtime_entries (container_name TEXT PRIMARY KEY, container_type TEXT NOT NULL,
      image TEXT NOT NULL, status TEXT NOT NULL, description TEXT, metadata_json TEXT NOT NULL,
      updated_at TEXT NOT NULL) STRICT;
  `);
  // Legacy tables that should be dropped by migration v4.
  legacyDatabase.exec(`
    CREATE TABLE approvals (approval_id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, status TEXT NOT NULL, requested_at TEXT NOT NULL,
      resolved_at TEXT, payload_json TEXT NOT NULL) STRICT;
  `);
  legacyDatabase.exec(`
    CREATE TABLE bindings (binding_key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      source_kind TEXT NOT NULL, source_platform TEXT, updated_at TEXT NOT NULL) STRICT;
  `);
  legacyDatabase.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', '3')`).run();
  legacyDatabase.close();

  const store = SqliteInternalStateStore.open(security.stateFilePath);

  try {
    assert.equal(store.getSchemaVersion(), CURRENT_SCHEMA_VERSION);

    const row = store.rawDatabase
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table'
           AND name IN ('approvals', 'bindings')`,
      )
      .all() as Array<{ name: string }>;

    assert.deepEqual(row, []);
  } finally {
    store.close();
  }
});

test('SqliteInternalStateStore migrates a v4 database to v5 and FK integrity holds', async (t) => {
  const { security } = await createSecurityFixture(t);

  // Create a v4 database by opening with the store (which runs all migrations)
  // then manually resetting the version to 4 and rebuilding the old schema.
  // Simpler: just create the v4 schema manually.
  const raw = new DatabaseSync(security.stateFilePath);
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`);
  raw.exec(`INSERT INTO meta(key, value) VALUES ('schema_version', '4');`);
  raw.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_platform TEXT,
      interactive INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      description TEXT,
      description_source TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      completed_turn_count INTEGER NOT NULL DEFAULT 0,
      last_summarized_history_count INTEGER NOT NULL DEFAULT 0,
      last_summarized_turn_count INTEGER NOT NULL DEFAULT 0,
      last_summarized_at TEXT,
      last_message_preview TEXT,
      working_memory TEXT,
      working_memory_updated_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'idle'
    ) STRICT;
  `);
  raw.exec(`
    CREATE TABLE session_messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
  raw.exec(`
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
  raw.exec(`
    CREATE TABLE episodic_checkpoints (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      checkpoint_type TEXT NOT NULL,
      reason TEXT NOT NULL,
      history_from INTEGER NOT NULL,
      history_to INTEGER NOT NULL,
      turn_count INTEGER NOT NULL,
      summary TEXT NOT NULL,
      FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    ) STRICT;
  `);
  raw.exec(`
    CREATE TABLE memories (
      memory_key TEXT PRIMARY KEY,
      memory_kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  raw.exec(`
    CREATE TABLE container_runtime_entries (
      container_name TEXT PRIMARY KEY,
      container_type TEXT NOT NULL,
      image TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT,
      metadata_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);

  // Seed data
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
