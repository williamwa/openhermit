import { mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PrismaClient } from '../generated/prisma/index.js';
import type { InternalStateStore } from '../interfaces.js';
import { SqliteSessionStore } from './session-store.js';
import { SqliteMessageStore } from './message-store.js';
import { SqliteMemoryProvider } from './memory-provider.js';
import { SqliteContainerStore } from './container-store.js';
import { SqliteInstructionStore } from './instruction-store.js';
import { SqliteUserStore } from './user-store.js';

// SHA-256 of prisma/migrations/0_baseline/migration.sql (must stay in sync if SQL changes)
const BASELINE_CHECKSUM = '365521592cffcda410d6e6b8d3b8d13e8b9c033cecf31af0ca383f22172b0787';
const BASELINE_NAME = '0_baseline';

/**
 * Read the baseline migration SQL from the package's prisma/migrations directory.
 * Works both in src/ (dev) and dist/ (built) layouts.
 */
function readBaselineSql(): string {
  // __dirname equivalent for ESM: packages/store/src/sqlite/ or packages/store/dist/sqlite/
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // Go up two levels (sqlite/ -> src|dist/ -> packages/store/) then into prisma/migrations
  const sqlPath = path.resolve(dir, '../../prisma/migrations/0_baseline/migration.sql');
  return readFileSync(sqlPath, 'utf8');
}

/**
 * Bootstrap the database schema for this database path.
 *
 * Three cases:
 *  1. _prisma_migrations exists → already Prisma-managed, nothing to do.
 *  2. sessions table exists but no _prisma_migrations → pre-Prisma database (migrated
 *     by the old raw migration system to v18). Mark baseline as applied without re-running DDL.
 *  3. Neither exists → fresh database. Run baseline DDL, then mark baseline as applied.
 */
async function bootstrapSchema(prisma: PrismaClient): Promise<void> {
  const [{ count: migrationsTableExists }] = await prisma.$queryRawUnsafe<[{ count: number }]>(
    `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`,
  );
  if (migrationsTableExists) return;

  const [{ count: sessionsTableExists }] = await prisma.$queryRawUnsafe<[{ count: number }]>(
    `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='sessions'`,
  );

  if (!sessionsTableExists) {
    // Fresh database: run baseline DDL
    const sql = readBaselineSql();
    // Split on double-newline boundaries between statements; filter empties
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) {
      await prisma.$executeRawUnsafe(stmt + ';');
    }
  }

  // Create the Prisma migrations tracking table
  await prisma.$executeRawUnsafe(`
    CREATE TABLE "_prisma_migrations" (
      "id"                  TEXT NOT NULL PRIMARY KEY,
      "checksum"            TEXT NOT NULL,
      "finished_at"         DATETIME,
      "migration_name"      TEXT NOT NULL,
      "logs"                TEXT,
      "rolled_back_at"      DATETIME,
      "started_at"          DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER NOT NULL DEFAULT 0
    )
  `);

  await prisma.$executeRawUnsafe(
    `INSERT INTO "_prisma_migrations"
       (id, checksum, finished_at, migration_name, logs, started_at, applied_steps_count)
     VALUES (?, ?, datetime('now'), ?, NULL, datetime('now'), 1)`,
    randomUUID(),
    BASELINE_CHECKSUM,
    BASELINE_NAME,
  );
}

export class SqliteInternalStateStore implements InternalStateStore {
  readonly sessions: SqliteSessionStore;
  readonly messages: SqliteMessageStore;
  readonly memories: SqliteMemoryProvider;
  readonly containers: SqliteContainerStore;
  readonly instructions: SqliteInstructionStore;
  readonly users: SqliteUserStore;

  private constructor(
    private readonly prisma: PrismaClient,
    public readonly databasePath: string,
  ) {
    this.sessions = new SqliteSessionStore(prisma);
    this.messages = new SqliteMessageStore(prisma);
    this.memories = new SqliteMemoryProvider(prisma);
    this.containers = new SqliteContainerStore(prisma);
    this.instructions = new SqliteInstructionStore(prisma);
    this.users = new SqliteUserStore(prisma);
  }

  static async open(databasePath: string): Promise<SqliteInternalStateStore> {
    mkdirSync(path.dirname(databasePath), { recursive: true });

    const prisma = new PrismaClient({
      datasourceUrl: `file:${databasePath}`,
    });

    try {
      await prisma.$connect();

      // Set SQLite PRAGMAs for performance and safety.
      // Some PRAGMAs return result sets, so use $queryRawUnsafe to avoid the
      // "Execute returned results" error from $executeRawUnsafe.
      await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
      await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
      await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');

      // Ensure schema is up to date (creates tables on fresh DB, marks baseline on pre-Prisma DB).
      // The baseline migration also creates the memories_fts FTS5 virtual table.
      await bootstrapSchema(prisma);

      return new SqliteInternalStateStore(prisma, databasePath);
    } catch (error) {
      await prisma.$disconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export { SqliteSessionStore } from './session-store.js';
export { SqliteMessageStore } from './message-store.js';
export { SqliteMemoryProvider } from './memory-provider.js';
export { SqliteContainerStore } from './container-store.js';
export { SqliteInstructionStore } from './instruction-store.js';
export { SqliteUserStore } from './user-store.js';
