import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/index.js';

import type { MemoryProvider } from '../interfaces.js';
import type { MemoryAddInput, MemoryEntry, MemorySearchOptions, MemoryUpdateInput, StoreScope } from '../types.js';

export class SqliteMemoryProvider implements MemoryProvider {
  readonly name = 'sqlite';

  constructor(private readonly prisma: PrismaClient) {}

  async initialize(_scope: StoreScope): Promise<void> {
    // Tables are bootstrapped during database creation, nothing to do here.
  }

  async shutdown(): Promise<void> {
    // Database lifecycle is managed by SqliteInternalStateStore.
  }

  async add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry> {
    const id = input.id?.trim() || `mem-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(input.metadata ?? {});

    await this.prisma.$transaction(async (tx) => {
      await tx.memory.upsert({
        where: { agentId_memoryKey: { agentId: scope.agentId, memoryKey: id } },
        create: {
          agentId: scope.agentId,
          memoryKey: id,
          content: input.content,
          metadataJson,
          createdAt: now,
          updatedAt: now,
        },
        update: {
          content: input.content,
          metadataJson,
          updatedAt: now,
        },
      });

      // Keep FTS index in sync — delete old row (if any) then insert fresh.
      await tx.$executeRawUnsafe(
        `DELETE FROM memories_fts WHERE agent_id = ? AND memory_key = ?`,
        scope.agentId, id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO memories_fts(agent_id, memory_key, content) VALUES (?, ?, ?)`,
        scope.agentId, id, input.content,
      );
    });

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
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Tokenize query into words and build FTS5 match expression.
    const words = trimmed.split(/\s+/).filter(Boolean);
    const ftsQuery = words.map((w) => `"${w.replace(/"/g, '""')}"`).join(' ');

    try {
      // Use FTS5 full-text search with porter stemming.
      // Use raw query because FTS5 is not modeled in Prisma.
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        memory_key: string;
        content: string;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>>(
        `SELECT m.memory_key, m.content, m.metadata_json, m.created_at, m.updated_at
         FROM memories m
         WHERE m.agent_id = ?
           AND m.memory_key IN (
             SELECT DISTINCT memory_key FROM memories_fts
             WHERE memories_fts MATCH ? AND agent_id = ?
           )
         ORDER BY m.updated_at DESC
         LIMIT ?`,
        scope.agentId, ftsQuery, scope.agentId, limit,
      );

      return rows.map((row) => ({
        id: row.memory_key,
        content: row.content,
        metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch {
      // FTS table may not exist yet. Fall back to LIKE matching.
      const term = `%${trimmed.toLowerCase()}%`;
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        memory_key: string;
        content: string;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>>(
        `SELECT memory_key, content, metadata_json, created_at, updated_at
         FROM memories
         WHERE agent_id = ?
           AND (lower(memory_key) LIKE ? OR lower(content) LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
        scope.agentId, term, term, limit,
      );

      return rows.map((row) => ({
        id: row.memory_key,
        content: row.content,
        metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    }
  }

  async get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined> {
    const row = await this.prisma.memory.findUnique({
      where: { agentId_memoryKey: { agentId: scope.agentId, memoryKey: id } },
    });

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
    if (!existing) {
      throw new Error(`Memory entry not found: ${id}`);
    }

    const content = input.content ?? existing.content;
    const metadata = input.metadata !== undefined
      ? { ...existing.metadata, ...input.metadata }
      : existing.metadata;
    const now = new Date().toISOString();

    await this.prisma.$transaction(async (tx) => {
      await tx.memory.update({
        where: { agentId_memoryKey: { agentId: scope.agentId, memoryKey: id } },
        data: {
          content,
          metadataJson: JSON.stringify(metadata ?? {}),
          updatedAt: now,
        },
      });

      // Keep FTS index in sync.
      await tx.$executeRawUnsafe(
        `DELETE FROM memories_fts WHERE agent_id = ? AND memory_key = ?`,
        scope.agentId, id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO memories_fts(agent_id, memory_key, content) VALUES (?, ?, ?)`,
        scope.agentId, id, content,
      );
    });

    return {
      id,
      content,
      metadata,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
  }

  async delete(scope: StoreScope, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.memory.delete({
        where: { agentId_memoryKey: { agentId: scope.agentId, memoryKey: id } },
      });
      await tx.$executeRawUnsafe(
        `DELETE FROM memories_fts WHERE agent_id = ? AND memory_key = ?`,
        scope.agentId, id,
      );
    });
  }

  async getContextBlock(
    scope: StoreScope,
    options?: { limit?: number | undefined },
  ): Promise<string | undefined> {
    const limit = Math.max(1, Math.min(50, options?.limit ?? 10));

    const rows = await this.prisma.memory.findMany({
      where: { agentId: scope.agentId },
      select: { memoryKey: true, content: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    if (rows.length === 0) return undefined;

    return rows
      .map((row) => `## ${row.memoryKey}\n${row.content}`)
      .join('\n\n');
  }
}
