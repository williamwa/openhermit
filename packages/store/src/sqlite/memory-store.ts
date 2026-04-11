import type { DatabaseSync } from 'node:sqlite';

import type { MemoryStore } from '../interfaces.js';
import type { LongTermMemoryInput, MemoryEntry, StoreScope } from '../types.js';

export class SqliteMemoryStore implements MemoryStore {
  constructor(private readonly database: DatabaseSync) {}

  async getMemory(scope: StoreScope, key: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT content
         FROM memories
         WHERE agent_id = ? AND memory_key = ?`,
      )
      .get(scope.agentId, key) as { content?: string } | undefined;

    return typeof row?.content === 'string' ? row.content : undefined;
  }

  async getMemoryEntry(scope: StoreScope, key: string): Promise<MemoryEntry | undefined> {
    const row = this.database
      .prepare(
        `SELECT memory_key, content, metadata_json, updated_at
         FROM memories
         WHERE agent_id = ? AND memory_key = ?`,
      )
      .get(scope.agentId, key) as {
      memory_key: string;
      content: string;
      metadata_json: string;
      updated_at: string;
    } | undefined;

    if (!row) {
      return undefined;
    }

    const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;

    return {
      memoryKey: row.memory_key,
      content: row.content,
      ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
      ...(Array.isArray(metadata.tags) ? { tags: metadata.tags as string[] } : {}),
      updatedAt: row.updated_at,
    };
  }

  async setMemory(
    scope: StoreScope,
    key: string,
    content: string,
    updatedAt: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO memories(agent_id, memory_key, memory_kind, content, metadata_json, updated_at)
         VALUES (?, ?, 'named', ?, ?, ?)
         ON CONFLICT(agent_id, memory_key) DO UPDATE SET
           content = excluded.content,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(scope.agentId, key, content, JSON.stringify(metadata), updatedAt);
  }

  async getMainMemory(scope: StoreScope): Promise<string | undefined> {
    return this.getMemory(scope, 'main');
  }

  async getNowMemory(scope: StoreScope): Promise<string | undefined> {
    return this.getMemory(scope, 'now');
  }

  async recallLongTermMemories(
    scope: StoreScope,
    query: string,
    limit: number,
    keyPrefix?: string,
  ): Promise<MemoryEntry[]> {
    const term = `%${query.trim().toLowerCase()}%`;
    const prefix = keyPrefix?.trim() ? `${keyPrefix.trim()}%` : undefined;
    const rows = this.database
      .prepare(
        `SELECT memory_key, content, metadata_json, updated_at
         FROM memories
         WHERE agent_id = ?
           AND (
             lower(memory_key) LIKE ?
             OR lower(content) LIKE ?
             OR lower(COALESCE(json_extract(metadata_json, '$.title'), '')) LIKE ?
           )
           AND (? IS NULL OR memory_key LIKE ?)
         ORDER BY updated_at DESC, memory_key ASC
         LIMIT ?`,
      )
      .all(scope.agentId, term, term, term, prefix ?? null, prefix ?? null, limit) as Array<{
      memory_key: string;
      content: string;
      metadata_json: string;
      updated_at: string;
    }>;

    return rows.map((row) => {
      const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;

      return {
        memoryKey: row.memory_key,
        content: row.content,
        ...(typeof metadata.title === 'string' ? { title: metadata.title } : {}),
        ...(Array.isArray(metadata.tags) ? { tags: metadata.tags as string[] } : {}),
        updatedAt: row.updated_at,
      };
    });
  }

  async upsertLongTermMemory(scope: StoreScope, input: LongTermMemoryInput): Promise<MemoryEntry> {
    const metadata = {
      ...(input.title ? { title: input.title } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    };

    this.database
      .prepare(
        `INSERT INTO memories(agent_id, memory_key, memory_kind, content, metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, memory_key) DO UPDATE SET
           memory_kind = excluded.memory_kind,
           content = excluded.content,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        scope.agentId,
        input.key,
        input.kind ?? 'named',
        input.content,
        JSON.stringify(metadata),
        input.updatedAt,
      );

    return {
      memoryKey: input.key,
      content: input.content,
      ...(input.title ? { title: input.title } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      updatedAt: input.updatedAt,
    };
  }
}
