import type { DatabaseSync } from 'node:sqlite';

import { STANDALONE_AGENT_ID } from '../types.js';

const legacyTableNames = [
  'identity_inputs',
  'identity_state',
  'approvals',
  'bindings',
  'schedule_runs',
  'schedules',
] as const;

// PRAGMAs are now set explicitly in bootstrapDatabase() to control
// the order relative to migrations (foreign_keys OFF during migrations).
// This array is kept for reference but no longer used at top level.

const migration1Statements = [
  `CREATE TABLE IF NOT EXISTS sessions (
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
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS session_messages (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_session_messages_session_ts
    ON session_messages(session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS session_events (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_session_events_session_ts
    ON session_events(session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS episodic_checkpoints (
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
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_episodic_checkpoints_session_ts
    ON episodic_checkpoints(session_id, ts DESC);`,
  `CREATE TABLE IF NOT EXISTS memories (
    memory_key TEXT PRIMARY KEY,
    memory_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_memories_kind_key
    ON memories(memory_kind, memory_key);`,
  `CREATE TABLE IF NOT EXISTS container_runtime_entries (
    container_name TEXT PRIMARY KEY,
    container_type TEXT NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL,
    description TEXT,
    metadata_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`,
] as const;

type Migration = {
  version: number;
  up: (database: DatabaseSync) => void;
};

const ensureSessionColumns = (database: DatabaseSync): void => {
  const rows = database
    .prepare(`PRAGMA table_info(sessions)`)
    .all() as Array<{ name?: string }>;
  const names = new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === 'string'),
  );

  if (!names.has('working_memory')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN working_memory TEXT;`);
  }

  if (!names.has('working_memory_updated_at')) {
    database.exec(`ALTER TABLE sessions ADD COLUMN working_memory_updated_at TEXT;`);
  }
};

const dropLegacyTables = (database: DatabaseSync): void => {
  for (const tableName of legacyTableNames) {
    database.exec(`DROP TABLE IF EXISTS ${tableName};`);
  }
};

const addAgentIdColumn = (database: DatabaseSync): void => {
  // NOTE: PRAGMA foreign_keys = OFF must be set OUTSIDE any transaction —
  // SQLite silently ignores it inside BEGIN/COMMIT. The caller (bootstrapDatabase)
  // handles this before running migrations.

  // Rebuild all tables with agent_id column and updated PKs / FKs.
  // SQLite cannot alter PKs or FKs, so we recreate each table.

  // -- sessions: PK was (session_id), now (agent_id, session_id)
  database.exec(`
    CREATE TABLE sessions_new (
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
      metadata_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'idle',
      PRIMARY KEY (agent_id, session_id)
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO sessions_new
    SELECT '${STANDALONE_AGENT_ID}', session_id, source_kind, source_platform, interactive,
           created_at, last_activity_at, description, description_source,
           message_count, completed_turn_count, last_summarized_history_count,
           last_summarized_turn_count, last_summarized_at, last_message_preview,
           working_memory, working_memory_updated_at, metadata_json, status
    FROM sessions;
  `);
  database.exec(`DROP TABLE sessions;`);
  database.exec(`ALTER TABLE sessions_new RENAME TO sessions;`);

  // -- session_messages: add agent_id, drop old FK, add composite FK
  database.exec(`
    CREATE TABLE session_messages_new (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY(agent_id, session_id) REFERENCES sessions(agent_id, session_id) ON DELETE CASCADE
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO session_messages_new(id, agent_id, session_id, ts, role, content, metadata_json)
    SELECT id, '${STANDALONE_AGENT_ID}', session_id, ts, role, content, metadata_json
    FROM session_messages;
  `);
  database.exec(`DROP TABLE session_messages;`);
  database.exec(`ALTER TABLE session_messages_new RENAME TO session_messages;`);

  // -- session_events: add agent_id, drop old FK, add composite FK
  database.exec(`
    CREATE TABLE session_events_new (
      id INTEGER PRIMARY KEY,
      agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
      session_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(agent_id, session_id) REFERENCES sessions(agent_id, session_id) ON DELETE CASCADE
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO session_events_new(id, agent_id, session_id, ts, event_type, payload_json)
    SELECT id, '${STANDALONE_AGENT_ID}', session_id, ts, event_type, payload_json
    FROM session_events;
  `);
  database.exec(`DROP TABLE session_events;`);
  database.exec(`ALTER TABLE session_events_new RENAME TO session_events;`);

  // -- episodic_checkpoints: add agent_id, drop old FK, add composite FK
  database.exec(`
    CREATE TABLE episodic_checkpoints_new (
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
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO episodic_checkpoints_new(id, agent_id, session_id, ts, checkpoint_type, reason, history_from, history_to, turn_count, summary)
    SELECT id, '${STANDALONE_AGENT_ID}', session_id, ts, checkpoint_type, reason, history_from, history_to, turn_count, summary
    FROM episodic_checkpoints;
  `);
  database.exec(`DROP TABLE episodic_checkpoints;`);
  database.exec(`ALTER TABLE episodic_checkpoints_new RENAME TO episodic_checkpoints;`);

  // -- memories: PK was (memory_key), now (agent_id, memory_key)
  database.exec(`
    CREATE TABLE memories_new (
      agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
      memory_key TEXT NOT NULL,
      memory_kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, memory_key)
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO memories_new
    SELECT '${STANDALONE_AGENT_ID}', memory_key, memory_kind, content, metadata_json, updated_at
    FROM memories;
  `);
  database.exec(`DROP TABLE memories;`);
  database.exec(`ALTER TABLE memories_new RENAME TO memories;`);

  // -- container_runtime_entries: PK was (container_name), now (agent_id, container_name)
  database.exec(`
    CREATE TABLE container_runtime_entries_new (
      agent_id TEXT NOT NULL DEFAULT '${STANDALONE_AGENT_ID}',
      container_name TEXT NOT NULL,
      container_type TEXT NOT NULL,
      image TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT,
      metadata_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, container_name)
    ) STRICT;
  `);
  database.exec(`
    INSERT INTO container_runtime_entries_new
    SELECT '${STANDALONE_AGENT_ID}', container_name, container_type, image, status, description, metadata_json, updated_at
    FROM container_runtime_entries;
  `);
  database.exec(`DROP TABLE container_runtime_entries;`);
  database.exec(`ALTER TABLE container_runtime_entries_new RENAME TO container_runtime_entries;`);

  // Composite indexes for scoped queries
  database.exec(`CREATE INDEX idx_sessions_agent ON sessions(agent_id, last_activity_at DESC);`);
  database.exec(`CREATE INDEX idx_session_messages_agent_session ON session_messages(agent_id, session_id, ts DESC);`);
  database.exec(`CREATE INDEX idx_session_events_agent_session ON session_events(agent_id, session_id, ts DESC);`);
  database.exec(`CREATE INDEX idx_episodic_agent_session ON episodic_checkpoints(agent_id, session_id, ts DESC);`);
  database.exec(`CREATE INDEX idx_memories_agent ON memories(agent_id, memory_kind, memory_key);`);
  database.exec(`CREATE INDEX idx_containers_agent ON container_runtime_entries(agent_id, container_name);`);
};

const migrations: Migration[] = [
  {
    version: 1,
    up: (database) => {
      for (const statement of migration1Statements) {
        database.exec(statement);
      }
    },
  },
  {
    version: 2,
    up: (database) => {
      ensureSessionColumns(database);
    },
  },
  {
    version: 3,
    up: () => {},
  },
  {
    version: 4,
    up: (database) => {
      dropLegacyTables(database);
    },
  },
  {
    version: 5,
    up: (database) => {
      addAgentIdColumn(database);
    },
  },
];

export const CURRENT_SCHEMA_VERSION = 5;

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

const runMigrations = (database: DatabaseSync): void => {
  const currentVersion = readSchemaVersion(database);

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    database.exec('BEGIN');

    try {
      migration.up(database);
      writeSchemaVersion(database, migration.version);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
};

export const bootstrapDatabase = (database: DatabaseSync): void => {
  // WAL mode is safe to set at any time.
  database.exec('PRAGMA journal_mode = WAL;');

  // Disable FK checks while running migrations.  PRAGMA foreign_keys cannot
  // be changed inside a transaction (SQLite silently ignores it), so we set
  // it here — outside any transaction — and re-enable it after all migrations.
  database.exec('PRAGMA foreign_keys = OFF;');

  ensureMetaTable(database);
  runMigrations(database);

  // Re-enable FK enforcement for all subsequent operations.
  database.exec('PRAGMA foreign_keys = ON;');
};

export const getSchemaVersion = (database: DatabaseSync): number => {
  ensureMetaTable(database);
  return readSchemaVersion(database);
};
