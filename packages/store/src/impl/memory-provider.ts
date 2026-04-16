import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../generated/prisma/index.js';

import type { MemoryProvider } from '../interfaces.js';
import type { MemoryAddInput, MemoryEntry, MemorySearchOptions, MemoryUpdateInput, StoreScope } from '../types.js';

export class DbMemoryProvider implements MemoryProvider {
  readonly name = 'db';

  constructor(private readonly prisma: PrismaClient) {}

  async initialize(_scope: StoreScope): Promise<void> {
    // Tables and indexes are managed by Prisma migrations.
  }

  async shutdown(): Promise<void> {
    // Database lifecycle is managed by DbInternalStateStore.
  }

  async add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry> {
    const id = input.id?.trim() || `mem-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const metadataJson = JSON.stringify(input.metadata ?? {});

    await this.prisma.memory.upsert({
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

    try {
      // Use PostgreSQL tsvector full-text search with ranking.
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        memory_key: string;
        content: string;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>>(
        `SELECT m.memory_key, m.content, m.metadata_json, m.created_at, m.updated_at
         FROM memories m
         WHERE m.agent_id = $1
           AND m.content_tsv @@ plainto_tsquery('english', $2)
         ORDER BY ts_rank(m.content_tsv, plainto_tsquery('english', $2)) DESC
         LIMIT $3`,
        scope.agentId, trimmed, limit,
      );

      return rows.map((row) => ({
        id: row.memory_key,
        content: row.content,
        metadata: JSON.parse(row.metadata_json || '{}') as Record<string, unknown>,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch {
      // Fallback to ILIKE search if tsvector column is unavailable.
      const term = `%${trimmed}%`;
      const rows = await this.prisma.$queryRawUnsafe<Array<{
        memory_key: string;
        content: string;
        metadata_json: string;
        created_at: string;
        updated_at: string;
      }>>(
        `SELECT memory_key, content, metadata_json, created_at, updated_at
         FROM memories
         WHERE agent_id = $1
           AND (memory_key ILIKE $2 OR content ILIKE $3)
         ORDER BY updated_at DESC
         LIMIT $4`,
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

    await this.prisma.memory.update({
      where: { agentId_memoryKey: { agentId: scope.agentId, memoryKey: id } },
      data: {
        content,
        metadataJson: JSON.stringify(metadata ?? {}),
        updatedAt: now,
      },
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
    await this.prisma.memory.delete({
      where: { agentId_memoryKey: { agentId: scope.agentId, memoryKey: id } },
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
