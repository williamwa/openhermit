import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { internalStateFiles } from '@openhermit/shared';

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

test('AgentSecurity exposes per-agent internal state paths outside the workspace', async (t) => {
  const { security, root } = await createSecurityFixture(t);

  assert.match(security.stateFilePath, new RegExp(`${internalStateFiles.sqlite.replace('.', '\\.')}$`));
  assert.match(security.runtimeFilePath, new RegExp(`${internalStateFiles.runtime.replace('.', '\\.')}$`));
  assert.equal(security.stateFilePath.startsWith(root), false);
  assert.equal(security.runtimeFilePath.startsWith(root), false);
});
