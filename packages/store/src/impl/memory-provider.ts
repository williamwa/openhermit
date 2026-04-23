import { randomUUID } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';

import type { MemoryProvider } from '../interfaces.js';
import type { MemoryAddInput, MemoryEntry, MemorySearchOptions, MemoryUpdateInput, StoreScope } from '../types.js';
import { memories } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbMemoryProvider implements MemoryProvider {
  readonly name = 'db';

  constructor(private readonly db: DrizzleDb) {}

  async initialize(_scope: StoreScope): Promise<void> {}
  async shutdown(): Promise<void> {}

  async add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry> {
    const id = input.id?.trim() || `mem-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(input.metadata ?? {});

    await this.db.insert(memories).values({
      agentId: scope.agentId,
      memoryKey: id,
      content: input.content,
      metadataJson,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [memories.agentId, memories.memoryKey],
      set: { content: input.content, metadataJson, updatedAt: now },
    });

    return { id, content: input.content, metadata: input.metadata ?? {}, createdAt: now, updatedAt: now };
  }

  async search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));
    const trimmed = query.trim();
    if (!trimmed) return [];

    try {
      const rows = await this.db.execute<{
        memory_key: string;
        content: string;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>(sql`
        SELECT m.memory_key, m.content, m.metadata_json, m.created_at, m.updated_at
        FROM memories m
        WHERE m.agent_id = ${scope.agentId}
          AND m.content_tsv @@ plainto_tsquery('english', ${trimmed})
        ORDER BY ts_rank(m.content_tsv, plainto_tsquery('english', ${trimmed})) DESC
        LIMIT ${limit}
      `);

      return rows.rows.map((row) => ({
        id: row.memory_key,
        content: row.content,
        metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch {
      const term = `%${trimmed}%`;
      const rows = await this.db.execute<{
        memory_key: string;
        content: string;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>(sql`
        SELECT memory_key, content, metadata_json, created_at, updated_at
        FROM memories
        WHERE agent_id = ${scope.agentId}
          AND (memory_key ILIKE ${term} OR content ILIKE ${term})
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `);

      return rows.rows.map((row) => ({
        id: row.memory_key,
        content: row.content,
        metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    }
  }

  async get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined> {
    const [row] = await this.db.select().from(memories)
      .where(and(eq(memories.agentId, scope.agentId), eq(memories.memoryKey, id)));
    if (!row) return undefined;
    return {
      id: row.memoryKey,
      content: row.content,
      metadata: JSON.parse(row.metadataJson || '{}') as Record<string, unknown>,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry> {
    const existing = await this.get(scope, id);
    if (!existing) throw new Error(`Memory entry not found: ${id}`);

    const content = input.content ?? existing.content;
    const metadata = input.metadata !== undefined ? { ...existing.metadata, ...input.metadata } : existing.metadata;
    const now = new Date().toISOString();

    await this.db.update(memories).set({
      content,
      metadataJson: JSON.stringify(metadata ?? {}),
      updatedAt: now,
    }).where(and(eq(memories.agentId, scope.agentId), eq(memories.memoryKey, id)));

    return { id, content, metadata, createdAt: existing.createdAt, updatedAt: now };
  }

  async delete(scope: StoreScope, id: string): Promise<void> {
    await this.db.delete(memories)
      .where(and(eq(memories.agentId, scope.agentId), eq(memories.memoryKey, id)));
  }

  async getContextBlock(scope: StoreScope, options?: { limit?: number | undefined }): Promise<string | undefined> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));
    const rows = await this.db.select({ memoryKey: memories.memoryKey, content: memories.content })
      .from(memories)
      .where(eq(memories.agentId, scope.agentId))
      .orderBy(desc(memories.updatedAt))
      .limit(limit);
    if (rows.length === 0) return undefined;
    return rows.map((row) => `## ${row.memoryKey}\n${row.content}`).join('\n\n');
  }
}
