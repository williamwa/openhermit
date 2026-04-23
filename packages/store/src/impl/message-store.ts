import type { SessionAttachment, SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';
import type { PrismaClient } from '../generated/prisma/index.js';

import type { MessageStore } from '../interfaces.js';
import type {
  MessageRow,
  SessionLogEntry,
  StoreScope,
} from '../types.js';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const mapEventRowToHistoryMessage = (row: {
  ts: string;
  eventType: string;
  content: string | null;
  payloadJson: string;
}): SessionHistoryMessage => {
  const payload = asRecord(JSON.parse(row.payloadJson || '{}'));

  if (row.eventType === 'user') {
    const message: SessionHistoryMessage = {
      ts: row.ts,
      role: 'user',
      content: row.content ?? '',
    };

    if (typeof payload?.messageId === 'string') {
      message.messageId = payload.messageId;
    }

    if (Array.isArray(payload?.attachments)) {
      message.attachments = payload.attachments as SessionAttachment[];
    }

    return message;
  }

  if (row.eventType === 'assistant') {
    const message: SessionHistoryMessage = {
      ts: row.ts,
      role: 'assistant',
      content: row.content ?? '',
    };

    if (typeof payload?.provider === 'string') {
      message.provider = payload.provider;
    }

    if (typeof payload?.model === 'string') {
      message.model = payload.model;
    }

    if (typeof payload?.stopReason === 'string') {
      message.stopReason = payload.stopReason;
    }

    return message;
  }

  if (row.eventType === 'tool_requested' || row.eventType === 'tool_started' || row.eventType === 'tool_result') {
    const phase = row.eventType === 'tool_requested' ? 'requested' as const
      : row.eventType === 'tool_started' ? 'started' as const
      : 'result' as const;
    return {
      ts: row.ts,
      role: 'tool' as const,
      content: (payload?.text as string) ?? '',
      tool: (payload?.name as string) || (payload?.tool as string) || '',
      toolPhase: phase,
      toolIsError: phase === 'result' ? (payload?.isError as boolean) ?? false : undefined,
      toolArgs: payload?.args,
    };
  }

  return {
    ts: row.ts,
    role: 'error',
    content: row.content ?? '',
  };
};

/**
 * Derive the content column value from a SessionLogEntry.
 * Returns the text content for user/assistant/error entries, null otherwise.
 */
const deriveContent = (entry: SessionLogEntry): string | null => {
  if ((entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string') {
    return entry.content;
  }
  if (entry.role === 'error' && typeof entry.message === 'string') {
    return entry.message;
  }
  return null;
};

const createSessionStartedEntries = (
  spec: SessionSpec,
  model: { provider: string; model: string },
) => {
  const ts = new Date().toISOString();

  return {
    session: {
      ts,
      role: 'system' as const,
      type: 'session_started' as const,
      sessionId: spec.sessionId,
      source: spec.source,
      ...(spec.metadata ? { metadata: spec.metadata } : {}),
      model,
    },
  };
};

const parseStoredSessionLogEntry = (payloadJson: string): SessionLogEntry =>
  JSON.parse(payloadJson) as SessionLogEntry;

export class DbMessageStore implements MessageStore {
  constructor(private readonly prisma: PrismaClient) {}

  async appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<void> {
    const content = deriveContent(entry);
    const userId = typeof entry.userId === 'string' ? entry.userId : null;

    await this.prisma.sessionEvent.create({
      data: {
        agentId: scope.agentId,
        sessionId,
        ts: entry.ts,
        eventType: entry.type ?? entry.role,
        payloadJson: JSON.stringify(entry),
        content,
        userId,
      },
    });
  }

  async writeSessionStarted(
    scope: StoreScope,
    spec: SessionSpec,
    model: { provider: string; model: string },
  ): Promise<void> {
    const entries = createSessionStartedEntries(spec, model);
    await this.appendLogEntry(scope, spec.sessionId, entries.session);
  }

  async listHistoryMessages(scope: StoreScope, sessionId: string): Promise<SessionHistoryMessage[]> {
    const rows = await this.prisma.sessionEvent.findMany({
      where: {
        agentId: scope.agentId,
        sessionId,
        OR: [
          { content: { not: null } },
          { eventType: { in: ['tool_requested', 'tool_started', 'tool_result'] } },
        ],
      },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
    });

    return rows.map(mapEventRowToHistoryMessage);
  }

  async listMessagesSinceEvent(scope: StoreScope, sessionId: string, afterEventId: number): Promise<MessageRow[]> {
    const rows = await this.prisma.sessionEvent.findMany({
      where: {
        agentId: scope.agentId,
        sessionId,
        id: { gt: afterEventId },
        eventType: { in: ['user', 'assistant', 'error'] },
      },
      orderBy: { id: 'asc' },
    });

    return rows.map((row) => ({
      ts: row.ts,
      role: row.eventType as 'user' | 'assistant' | 'error',
      content: row.content ?? '',
      ...(row.userId ? { userId: row.userId } : {}),
    }));
  }

  async getLatestEventId(scope: StoreScope, sessionId: string): Promise<number> {
    const row = await this.prisma.sessionEvent.findFirst({
      where: { agentId: scope.agentId, sessionId },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    return row?.id ?? 0;
  }

  async getLastIntrospectionEventId(scope: StoreScope, sessionId: string): Promise<number> {
    const row = await this.prisma.sessionEvent.findFirst({
      where: { agentId: scope.agentId, sessionId, eventType: 'introspection_end' },
      orderBy: { id: 'desc' },
      select: { id: true },
    });

    return row?.id ?? 0;
  }

  async getTurnsSinceLastIntrospection(scope: StoreScope, sessionId: string): Promise<number> {
    const lastId = await this.getLastIntrospectionEventId(scope, sessionId);
    const count = await this.prisma.sessionEvent.count({
      where: {
        agentId: scope.agentId,
        sessionId,
        eventType: 'agent_end',
        id: { gt: lastId },
      },
    });

    return count;
  }

  async listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]> {
    const rows = await this.prisma.sessionEvent.findMany({
      where: { agentId: scope.agentId, sessionId },
      orderBy: [{ ts: 'asc' }, { id: 'asc' }],
      select: { payloadJson: true },
    });

    return rows.map((row) => parseStoredSessionLogEntry(row.payloadJson));
  }

  async listRecentMessages(
    scope: StoreScope,
    sessionId: string,
    limit: number,
    offset?: number,
  ): Promise<MessageRow[]> {
    // Subquery pattern: get latest N messages then re-order ascending.
    // Use raw query to preserve the ORDER BY DESC + LIMIT + re-order pattern.
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      ts: string;
      role: string;
      content: string;
    }>>(
      `SELECT ts, event_type AS role, content FROM (
         SELECT ts, event_type, content, id
         FROM session_events
         WHERE agent_id = $1 AND session_id = $2 AND event_type IN ('user', 'assistant', 'error')
         ORDER BY id DESC
         LIMIT $3 OFFSET $4
       ) sub ORDER BY id ASC`,
      scope.agentId, sessionId, limit, offset ?? 0,
    );

    return rows.map((row) => ({
      ts: row.ts,
      role: row.role as 'user' | 'assistant' | 'error',
      content: row.content,
    }));
  }

  async listSessionEntriesSinceLastCompaction(
    scope: StoreScope,
    sessionId: string,
  ): Promise<{ compactionSummary: string | undefined; entries: SessionLogEntry[] }> {
    // Find the last compaction event.
    const compactionRow = await this.prisma.sessionEvent.findFirst({
      where: { agentId: scope.agentId, sessionId, eventType: 'context_compaction' },
      orderBy: { id: 'desc' },
      select: { id: true, payloadJson: true },
    });

    const afterId = compactionRow?.id ?? 0;
    let compactionSummary: string | undefined;

    if (compactionRow) {
      const parsed = JSON.parse(compactionRow.payloadJson) as Record<string, unknown>;
      compactionSummary = typeof parsed.content === 'string' ? parsed.content : undefined;
    }

    // Load all entries after the compaction event (or from beginning).
    const rows = await this.prisma.sessionEvent.findMany({
      where: {
        agentId: scope.agentId,
        sessionId,
        id: { gt: afterId },
      },
      orderBy: { id: 'asc' },
      select: { payloadJson: true },
    });

    return {
      compactionSummary,
      entries: rows.map((row) => parseStoredSessionLogEntry(row.payloadJson)),
    };
  }

  async getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined> {
    const row = await this.prisma.session.findUnique({
      where: { agentId_sessionId: { agentId: scope.agentId, sessionId } },
      select: { workingMemory: true },
    });

    return row?.workingMemory ?? undefined;
  }

  async setSessionWorkingMemory(
    scope: StoreScope,
    sessionId: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    await this.prisma.session.update({
      where: { agentId_sessionId: { agentId: scope.agentId, sessionId } },
      data: { workingMemory: content, workingMemoryUpdatedAt: updatedAt },
    });
  }

  async getCompactionSummary(scope: StoreScope, sessionId: string): Promise<string | undefined> {
    const row = await this.prisma.sessionEvent.findFirst({
      where: { agentId: scope.agentId, sessionId, eventType: 'context_compaction' },
      orderBy: { id: 'desc' },
      select: { payloadJson: true },
    });

    if (!row) return undefined;

    const parsed = JSON.parse(row.payloadJson) as Record<string, unknown>;
    return typeof parsed.content === 'string' ? parsed.content : undefined;
  }

  async setCompactionSummary(
    scope: StoreScope,
    sessionId: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    await this.appendLogEntry(scope, sessionId, {
      ts: updatedAt,
      role: 'system',
      type: 'context_compaction',
      content,
    });
  }
}
