import type { DatabaseSync } from 'node:sqlite';

import { STANDALONE_AGENT_ID } from '../types.js';

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS sessions (
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    session_id TEXT NOT NULL,
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
    compaction_summary TEXT,
    compaction_summary_updated_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle',
    PRIMARY KEY (agent_id, session_id)
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_agent
    ON sessions(agent_id, last_activity_at DESC);`,
  `CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(agent_id, session_id) REFERENCES sessions(agent_id, session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_session_messages_agent_session
    ON session_messages(agent_id, session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY(agent_id, session_id) REFERENCES sessions(agent_id, session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_agent_session
    ON session_events(agent_id, session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS episodic_checkpoints (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    checkpoint_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    history_from INTEGER NOT NULL,
    history_to INTEGER NOT NULL,
    turn_count INTEGER NOT NULL,
    summary TEXT NOT NULL,
    FOREIGN KEY(agent_id, session_id) REFERENCES sessions(agent_id, session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_episodic_agent_session
    ON episodic_checkpoints(agent_id, session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS memories (
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    memory_key TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, memory_key)
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_memories_agent
    ON memories(agent_id, updated_at DESC);`,
  `CREATE TABLE IF NOT EXISTS containers (
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    container_name TEXT NOT NULL,
    container_type TEXT NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    description TEXT,
    metadata_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, container_name)
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_containers_agent
    ON containers(agent_id, container_name);`,
  `CREATE TABLE IF NOT EXISTS instructions (
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    key TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, key)
  ) STRICT;`,
] as const;

const migrationStatements = [
  // v7: rename container_runtime_entries → containers
  `ALTER TABLE container_runtime_entries RENAME TO containers;`,
  // v8: drop memory_kind column, add created_at to memories
  `ALTER TABLE memories ADD COLUMN created_at TEXT NOT NULL DEFAULT '';`,
  `DROP INDEX IF EXISTS idx_memories_agent;`,
  `CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, updated_at DESC);`,
  // v9: add compaction_summary to sessions
  `ALTER TABLE sessions ADD COLUMN compaction_summary TEXT;`,
  `ALTER TABLE sessions ADD COLUMN compaction_summary_updated_at TEXT;`,
] as const;

export const CURRENT_SCHEMA_VERSION = 9;

const ensureMetaTable = (database: DatabaseSync): void => {
  database.exec(
    `CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;`,
  );
};

const readSchemaVersion = (database: DatabaseSync): number => {
  const row = database
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value?: string } | undefined;
  const version = Number.parseInt(row?.value ?? '0', 10);

  return Number.isFinite(version) ? version : 0;
};

const writeSchemaVersion = (database: DatabaseSync, version: number): void => {
  database
    .prepare(
      `INSERT INTO meta(key, value)
       VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(version));
};

export const bootstrapDatabase = (database: DatabaseSync): void => {
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA foreign_keys = ON;');

  ensureMetaTable(database);
  const currentVersion = readSchemaVersion(database);

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    database.exec('BEGIN');

    try {
      if (currentVersion >= 1) {
        for (const statement of migrationStatements) {
          try {
            database.exec(statement);
          } catch {
            // Table may not exist (fresh DB) or already renamed — safe to skip.
          }
        }
      }

      for (const statement of schemaStatements) {
        database.exec(statement);
      }

      writeSchemaVersion(database, CURRENT_SCHEMA_VERSION);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
};

export const getSchemaVersion = (database: DatabaseSync): number => {
  ensureMetaTable(database);
  return readSchemaVersion(database);
};
