import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURRENT_SCHEMA_VERSION = 4;

const legacyTableNames = [
  'identity_inputs',
  'identity_state',
  'approvals',
  'bindings',
  'schedule_runs',
  'schedules',
] as const;

const bootstrapStatements = [
  'PRAGMA journal_mode = WAL;',
  'PRAGMA foreign_keys = ON;',
] as const;

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
    return readSchemaVersion(this.database);
  }
}

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
    // Keep the version boundary explicit so future schema changes stay append-only.
    version: 3,
    up: () => {},
  },
  {
    version: 4,
    up: (database) => {
      dropLegacyTables(database);
    },
  },
] as const;

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

    ensureMetaTable(database);
    runMigrations(database);

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const getCurrentInternalStateSchemaVersion = (): number =>
  CURRENT_SCHEMA_VERSION;
