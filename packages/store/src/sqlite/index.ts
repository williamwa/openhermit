import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '../generated/prisma/index.js';
import type { InternalStateStore } from '../interfaces.js';
import { SqliteSessionStore } from './session-store.js';
import { SqliteMessageStore } from './message-store.js';
import { SqliteMemoryProvider } from './memory-provider.js';
import { SqliteContainerStore } from './container-store.js';
import { SqliteInstructionStore } from './instruction-store.js';
import { SqliteUserStore } from './user-store.js';

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
      await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL;');
      await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000;');
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');

      // Create FTS5 virtual table (not supported by Prisma schema).
      await prisma.$executeRawUnsafe(
        `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          agent_id, memory_key, content,
          tokenize='porter unicode61'
        );`,
      );

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
