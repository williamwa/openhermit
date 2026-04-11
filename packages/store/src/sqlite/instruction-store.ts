import type { DatabaseSync } from 'node:sqlite';

import type { InstructionStore } from '../interfaces.js';
import type { InstructionEntry, StoreScope } from '../types.js';

export class SqliteInstructionStore implements InstructionStore {
  constructor(private readonly database: DatabaseSync) {}

  async get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined> {
    const row = this.database
      .prepare(
        `SELECT key, content, updated_at
         FROM instructions
         WHERE agent_id = ? AND key = ?`,
      )
      .get(scope.agentId, key) as {
      key: string;
      content: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      key: row.key,
      content: row.content,
      updatedAt: row.updated_at,
    };
  }

  async getAll(scope: StoreScope): Promise<InstructionEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT key, content, updated_at
         FROM instructions
         WHERE agent_id = ?
         ORDER BY key ASC`,
      )
      .all(scope.agentId) as Array<{
      key: string;
      content: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      key: row.key,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  async set(
    scope: StoreScope,
    key: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO instructions(agent_id, key, content, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(scope.agentId, key, content, updatedAt);
  }
}
