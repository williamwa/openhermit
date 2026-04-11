import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { InternalStateStore } from '../interfaces.js';
import { SqliteSessionStore } from './session-store.js';
import { SqliteMessageStore } from './message-store.js';
import { SqliteMemoryProvider } from './memory-provider.js';
import { SqliteContainerStore } from './container-store.js';
import { SqliteInstructionStore } from './instruction-store.js';
import { bootstrapDatabase, CURRENT_SCHEMA_VERSION, getSchemaVersion } from './migrations.js';

export class SqliteInternalStateStore implements InternalStateStore {
  readonly sessions: SqliteSessionStore;
  readonly messages: SqliteMessageStore;
  readonly memories: SqliteMemoryProvider;
  readonly containers: SqliteContainerStore;
  readonly instructions: SqliteInstructionStore;

  private constructor(
    private readonly database: DatabaseSync,
    public readonly databasePath: string,
  ) {
    this.sessions = new SqliteSessionStore(database);
    this.messages = new SqliteMessageStore(database);
    this.memories = new SqliteMemoryProvider(database);
    this.containers = new SqliteContainerStore(database);
    this.instructions = new SqliteInstructionStore(database);
  }

  static open(databasePath: string): SqliteInternalStateStore {
    mkdirSync(path.dirname(databasePath), { recursive: true });

    const database = new DatabaseSync(databasePath);

    try {
      bootstrapDatabase(database);
      return new SqliteInternalStateStore(database, databasePath);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Expose the raw database for callers that still need direct access during migration. */
  get rawDatabase(): DatabaseSync {
    return this.database;
  }

  getSchemaVersion(): number {
    return getSchemaVersion(this.database);
  }

  close(): void {
    this.database.close();
  }
}

export { SqliteSessionStore } from './session-store.js';
export { SqliteMessageStore } from './message-store.js';
export { SqliteMemoryProvider } from './memory-provider.js';
export { SqliteContainerStore } from './container-store.js';
export { SqliteInstructionStore } from './instruction-store.js';
export { CURRENT_SCHEMA_VERSION, bootstrapDatabase, getSchemaVersion } from './migrations.js';
