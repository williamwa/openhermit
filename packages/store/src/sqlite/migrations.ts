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
    last_introspection_event_id INTEGER NOT NULL DEFAULT 0,
    last_summarized_turn_count INTEGER NOT NULL DEFAULT 0,
    last_summarized_at TEXT,
    last_message_preview TEXT,
    working_memory TEXT,
    working_memory_updated_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'idle',
    PRIMARY KEY (agent_id, session_id)
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_agent
    ON sessions(agent_id, last_activity_at DESC);`,
  `CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY,
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    content TEXT,
    user_id TEXT,
    FOREIGN KEY(agent_id, session_id) REFERENCES sessions(agent_id, session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_agent_session
    ON session_events(agent_id, session_id, ts DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_type
    ON session_events(agent_id, session_id, event_type, id DESC);`,
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
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    agent_id, memory_key, content,
    tokenize='porter unicode61'
  );`,
  `CREATE TABLE IF NOT EXISTS users (
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT,
    merged_into TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, user_id)
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_users_agent
    ON users(agent_id, updated_at DESC);`,
  `CREATE TABLE IF NOT EXISTS user_identities (
    agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
    user_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, channel, channel_user_id),
    FOREIGN KEY(agent_id, user_id) REFERENCES users(agent_id, user_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_user_identities_user
    ON user_identities(agent_id, user_id);`,
] as const;

const migrationStatements = [
  // v7: rename container_runtime_entries → containers
  `ALTER TABLE container_runtime_entries RENAME TO containers;`,
  // v8: drop memory_kind column, add created_at to memories
  `ALTER TABLE memories ADD COLUMN created_at TEXT NOT NULL DEFAULT '';`,
  `DROP INDEX IF EXISTS idx_memories_agent;`,
  `CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, updated_at DESC);`,
  // v9: add compaction_summary to sessions (now obsolete — moved to session_events)
  `ALTER TABLE sessions ADD COLUMN compaction_summary TEXT;`,
  `ALTER TABLE sessions ADD COLUMN compaction_summary_updated_at TEXT;`,
  // v10: drop compaction_summary from sessions — compaction is now a session_event
  `ALTER TABLE sessions DROP COLUMN compaction_summary;`,
  `ALTER TABLE sessions DROP COLUMN compaction_summary_updated_at;`,
  // v11: drop obsolete memory_kind column from memories
  `ALTER TABLE memories DROP COLUMN memory_kind;`,
  // v12: drop episodic_checkpoints table — replaced by introspection events in session_events
  `DROP TABLE IF EXISTS episodic_checkpoints;`,
  // v13: add FTS5 index for memory search
  `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    agent_id, memory_key, content,
    tokenize='porter unicode61'
  );`,
  `INSERT INTO memories_fts(agent_id, memory_key, content)
   SELECT agent_id, memory_key, content FROM memories;`,
  // v14: add users and user_identities tables (created by schema statements)
  // v15: merge session_messages into session_events — add content + user_id columns, backfill, drop old table
  `ALTER TABLE session_events ADD COLUMN content TEXT;`,
  `ALTER TABLE session_events ADD COLUMN user_id TEXT;`,
  `UPDATE session_events SET content = json_extract(payload_json, '$.content') WHERE event_type IN ('user', 'assistant') AND json_extract(payload_json, '$.content') IS NOT NULL;`,
  `UPDATE session_events SET content = json_extract(payload_json, '$.message') WHERE event_type = 'error' AND json_extract(payload_json, '$.message') IS NOT NULL;`,
  `DROP INDEX IF EXISTS idx_session_messages_agent_session;`,
  `DROP TABLE IF EXISTS session_messages;`,
  // v16: replace last_summarized_history_count with last_introspection_event_id (event ID cursor)
  `ALTER TABLE sessions ADD COLUMN last_introspection_event_id INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE sessions DROP COLUMN last_summarized_history_count;`,
] as const;

export const CURRENT_SCHEMA_VERSION = 16;

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
