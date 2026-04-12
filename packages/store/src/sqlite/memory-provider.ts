import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { MemoryProvider } from '../interfaces.js';
import type { MemoryAddInput, MemoryEntry, MemorySearchOptions, MemoryUpdateInput, StoreScope } from '../types.js';

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = 'sqlite';

  constructor(private readonly database: DatabaseSync) {}

  async initialize(_scope: StoreScope): Promise<void> {
    // SQLite tables are bootstrapped during database creation, nothing to do here.
  }

  async shutdown(): Promise<void> {
    // Database lifecycle is managed by SqliteInternalStateStore.
  }

  async add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry> {
    const id = input.id?.trim() || `mem-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(input.metadata ?? {});

    this.database
      .prepare(
        `INSERT INTO memories(agent_id, memory_key, content, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, memory_key) DO UPDATE SET
           content = excluded.content,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(scope.agentId, id, input.content, metadataJson, now, now);

    return {
      id,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  async search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));
    const term = `%${query.trim().toLowerCase()}%`;

    const rows = this.database
      .prepare(
        `SELECT memory_key, content, metadata_json, created_at, updated_at
         FROM memories
         WHERE agent_id = ?
           AND (
             lower(memory_key) LIKE ?
             OR lower(content) LIKE ?
             OR lower(COALESCE(json_extract(metadata_json, '$.title'), '')) LIKE ?
           )
         ORDER BY updated_at DESC, memory_key ASC
         LIMIT ?`,
      )
      .all(scope.agentId, term, term, term, limit) as Array<{
      memory_key: string;
      content: string;
      metadata_json: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      id: row.memory_key,
      content: row.content,
      metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined> {
    const row = this.database
      .prepare(
        `SELECT memory_key, content, metadata_json, created_at, updated_at
         FROM memories
         WHERE agent_id = ? AND memory_key = ?`,
      )
      .get(scope.agentId, id) as {
      memory_key: string;
      content: string;
      metadata_json: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.memory_key,
      content: row.content,
      metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry> {
    const existing = await this.get(scope, id);
    if (!existing) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    const content = input.content ?? existing.content;
    const metadata = input.metadata !== undefined
      ? { ...existing.metadata, ...input.metadata }
      : existing.metadata;
    const now = new Date().toISOString();

    this.database
      .prepare(
        `UPDATE memories
         SET content = ?, metadata_json = ?, updated_at = ?
         WHERE agent_id = ? AND memory_key = ?`,
      )
      .run(content, JSON.stringify(metadata ?? {}), now, scope.agentId, id);

    return {
      id,
      content,
      metadata,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  }

  async delete(scope: StoreScope, id: string): Promise<void> {
    this.database
      .prepare(`DELETE FROM memories WHERE agent_id = ? AND memory_key = ?`)
      .run(scope.agentId, id);
  }

  async getContextBlock(
    scope: StoreScope,
    options?: { limit?: number | undefined },
  ): Promise<string | undefined> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));

    const rows = this.database
      .prepare(
        `SELECT memory_key, content
         FROM memories
         WHERE agent_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(scope.agentId, limit) as Array<{ memory_key: string; content: string }>;

    if (rows.length === 0) {
      return undefined;
    }

    return rows
      .map((row) => `## ${row.memory_key}\n${row.content}`)
      .join('\n\n');
  }
}
