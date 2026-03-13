import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURRENT_SCHEMA_VERSION = 1;

const bootstrapStatements = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
  `CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS identity_inputs (
    name TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS identity_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`,
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
    metadata_json TEXT NOT NULL DEFAULT '{}',
    episodic_relative_path TEXT NOT NULL,
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
  `CREATE TABLE IF NOT EXISTS session_working_memory (
    session_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS global_working_memory (
    singleton_key TEXT PRIMARY KEY CHECK (singleton_key = 'global'),
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS long_term_memory_entries (
    id INTEGER PRIMARY KEY,
    topic TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_long_term_memory_entries_topic
    ON long_term_memory_entries(topic);`,
  `CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    resolved_at TEXT,
    payload_json TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS bindings (
    binding_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_platform TEXT,
    updated_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS schedules (
    schedule_id TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;`,
  `CREATE TABLE IF NOT EXISTS schedule_runs (
    run_id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    output_json TEXT,
    FOREIGN KEY(schedule_id) REFERENCES schedules(schedule_id) ON DELETE CASCADE
  ) STRICT;`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_started
    ON schedule_runs(schedule_id, started_at DESC);`,
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

export interface InternalStateDatabase {
  close(): void;
  readonly databasePath: string;
  getSchemaVersion(): number;
}

class SqliteInternalStateDatabase implements InternalStateDatabase {
  constructor(
    public readonly databasePath: string,
    private readonly database: DatabaseSync,
  ) {}

  close(): void {
    this.database.close();
  }

  getSchemaVersion(): number {
    const row = this.database
      .prepare(`SELECT value FROM schema_meta WHERE key = 'schema_version'`)
      .get() as { value?: string } | undefined;
    return Number.parseInt(row?.value ?? '0', 10);
  }
}

export const initializeInternalStateDatabase = (
  databasePath: string,
): InternalStateDatabase => {
  const database = openInternalStateDatabase(databasePath);
  return new SqliteInternalStateDatabase(databasePath, database);
};

export const openInternalStateDatabase = (
  databasePath: string,
): DatabaseSync => {
  mkdirSync(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);

  try {
    for (const statement of bootstrapStatements) {
      database.exec(statement);
    }

    database
      .prepare(
        `INSERT INTO schema_meta(key, value)
         VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(CURRENT_SCHEMA_VERSION));

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};
