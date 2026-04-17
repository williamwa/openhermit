import type { MetadataValue, SessionType } from '@openhermit/protocol';
import type { PrismaClient } from '../generated/prisma/index.js';

import type { SessionStore } from '../interfaces.js';
import type { PersistedSessionIndexEntry, StoreScope } from '../types.js';

export class DbSessionStore implements SessionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async waitForIdle(): Promise<void> {
    // Prisma handles connection management internally.
  }

  async list(scope: StoreScope): Promise<PersistedSessionIndexEntry[]> {
    const rows = await this.prisma.session.findMany({
      where: { agentId: scope.agentId },
      orderBy: { lastActivityAt: 'desc' },
    });

    return rows.map((row) => this.rowToEntry(row));
  }

  async get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { agentId_sessionId: { agentId: scope.agentId, sessionId } },
    });

    if (!row) return undefined;
    return this.rowToEntry(row);
  }

  async upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void> {
    const data = {
      sourceKind: entry.source.kind,
      sourcePlatform: entry.source.platform ?? null,
      interactive: entry.source.interactive ? 1 : 0,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      description: entry.description ?? null,
      descriptionSource: entry.descriptionSource ?? null,
      messageCount: entry.messageCount,
      completedTurnCount: entry.completedTurnCount ?? 0,
      lastMessagePreview: entry.lastMessagePreview ?? null,
      metadataJson: JSON.stringify(entry.metadata ?? {}),
      status: entry.status ?? 'idle',
      type: entry.type ?? entry.source.type ?? 'direct',
    };

    await this.prisma.session.upsert({
      where: { agentId_sessionId: { agentId: scope.agentId, sessionId: entry.sessionId } },
      create: {
        agentId: scope.agentId,
        sessionId: entry.sessionId,
        ...data,
      },
      update: data,
    });
  }

  async updateDescription(scope: StoreScope, sessionId: string, description: string, source: 'fallback' | 'ai'): Promise<void> {
    await this.prisma.session.update({
      where: { agentId_sessionId: { agentId: scope.agentId, sessionId } },
      data: { description, descriptionSource: source },
    });
  }

  private rowToEntry(row: {
    sessionId: string;
    sourceKind: string;
    sourcePlatform: string | null;
    interactive: number;
    createdAt: string;
    lastActivityAt: string;
    description: string | null;
    descriptionSource: string | null;
    messageCount: number;
    completedTurnCount: number;
    lastMessagePreview: string | null;
    metadataJson: string;
    type: string;
  }): PersistedSessionIndexEntry {
    const metadata = JSON.parse(row.metadataJson || '{}') as Record<string, unknown>;
    const entry: PersistedSessionIndexEntry = {
      sessionId: row.sessionId,
      source: {
        kind: row.sourceKind,
        interactive: row.interactive === 1,
        ...(row.sourcePlatform !== null ? { platform: row.sourcePlatform } : {}),
        ...(row.type !== 'direct' ? { type: row.type as SessionType } : {}),
      },
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      messageCount: row.messageCount,
      completedTurnCount: row.completedTurnCount,
      ...(row.type !== 'direct' ? { type: row.type as SessionType } : {}),
    };

    if (row.description !== null) {
      entry.description = row.description;
    }

    if (row.descriptionSource === 'fallback' || row.descriptionSource === 'ai') {
      entry.descriptionSource = row.descriptionSource;
    }

    if (row.lastMessagePreview !== null) {
      entry.lastMessagePreview = row.lastMessagePreview;
    }

    if (Object.keys(metadata).length > 0) {
      entry.metadata = metadata as Record<string, MetadataValue>;
    }

    return entry;
  }
}
