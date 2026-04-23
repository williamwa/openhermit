import { eq, and, gt, inArray, desc, asc, sql } from 'drizzle-orm';
import type { SessionAttachment, SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';

import type { MessageStore } from '../interfaces.js';
import type { MessageRow, SessionLogEntry, StoreScope } from '../types.js';
import { sessionEvents, sessions } from '../schema.js';
import type { DrizzleDb } from './index.js';

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
    const message: SessionHistoryMessage = { ts: row.ts, role: 'user', content: row.content ?? '' };
    if (typeof payload?.messageId === 'string') message.messageId = payload.messageId;
    if (Array.isArray(payload?.attachments)) message.attachments = payload.attachments as SessionAttachment[];
    return message;
  }

  if (row.eventType === 'assistant') {
    const message: SessionHistoryMessage = { ts: row.ts, role: 'assistant', content: row.content ?? '' };
    if (typeof payload?.provider === 'string') message.provider = payload.provider;
    if (typeof payload?.model === 'string') message.model = payload.model;
    if (typeof payload?.stopReason === 'string') message.stopReason = payload.stopReason;
    return message;
  }

  if (row.eventType === 'tool_call' || row.eventType === 'tool_result') {
    const phase = row.eventType === 'tool_call' ? 'call' as const : 'result' as const;
    return {
      ts: row.ts,
      role: 'tool' as const,
      content: (payload?.text as string) ?? '',
      tool: (payload?.name as string) || (payload?.tool as string) || '',
      toolPhase: phase,
      toolIsError: phase === 'result' ? ((payload?.isError as boolean) ?? false) : false,
      toolArgs: payload?.args,
    };
  }

  return { ts: row.ts, role: 'error', content: row.content ?? '' };
};

const deriveContent = (entry: SessionLogEntry): string | null => {
  if ((entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string') return entry.content;
  if (entry.role === 'error' && typeof entry.message === 'string') return entry.message;
  return null;
};

const createSessionStartedEntries = (spec: SessionSpec, model: { provider: string; model: string }) => {
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
  constructor(private readonly db: DrizzleDb) {}

  async appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<void> {
    const content = deriveContent(entry);
    const userId = typeof entry.userId === 'string' ? entry.userId : null;

    await this.db.insert(sessionEvents).values({
      agentId: scope.agentId,
      sessionId,
      ts: entry.ts,
      eventType: entry.type ?? entry.role,
      payloadJson: JSON.stringify(entry),
      content,
      userId,
    });
  }

  async writeSessionStarted(scope: StoreScope, spec: SessionSpec, model: { provider: string; model: string }): Promise<void> {
    const entries = createSessionStartedEntries(spec, model);
    await this.appendLogEntry(scope, spec.sessionId, entries.session);
  }

  async listHistoryMessages(scope: StoreScope, sessionId: string): Promise<SessionHistoryMessage[]> {
    const rows = await this.db.select().from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        sql`(${sessionEvents.content} IS NOT NULL OR ${sessionEvents.eventType} IN ('tool_call', 'tool_result'))`,
      ))
      .orderBy(asc(sessionEvents.ts), asc(sessionEvents.id));

    return rows.map(mapEventRowToHistoryMessage);
  }

  async listMessagesSinceEvent(scope: StoreScope, sessionId: string, afterEventId: number): Promise<MessageRow[]> {
    const rows = await this.db.select().from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        gt(sessionEvents.id, afterEventId),
        inArray(sessionEvents.eventType, ['user', 'assistant', 'error']),
      ))
      .orderBy(asc(sessionEvents.id));

    return rows.map((row) => ({
      ts: row.ts,
      role: row.eventType as 'user' | 'assistant' | 'error',
      content: row.content ?? '',
      ...(row.userId ? { userId: row.userId } : {}),
    }));
  }

  async getLatestEventId(scope: StoreScope, sessionId: string): Promise<number> {
    const [row] = await this.db.select({ id: sessionEvents.id }).from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, scope.agentId), eq(sessionEvents.sessionId, sessionId)))
      .orderBy(desc(sessionEvents.id))
      .limit(1);
    return row?.id ?? 0;
  }

  async getLastIntrospectionEventId(scope: StoreScope, sessionId: string): Promise<number> {
    const [row] = await this.db.select({ id: sessionEvents.id }).from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.eventType, 'introspection_end'),
      ))
      .orderBy(desc(sessionEvents.id))
      .limit(1);
    return row?.id ?? 0;
  }

  async getTurnsSinceLastIntrospection(scope: StoreScope, sessionId: string): Promise<number> {
    const lastId = await this.getLastIntrospectionEventId(scope, sessionId);
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.eventType, 'agent_end'),
        gt(sessionEvents.id, lastId),
      ));
    return row?.count ?? 0;
  }

  async listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]> {
    const rows = await this.db.select({ payloadJson: sessionEvents.payloadJson }).from(sessionEvents)
      .where(and(eq(sessionEvents.agentId, scope.agentId), eq(sessionEvents.sessionId, sessionId)))
      .orderBy(asc(sessionEvents.ts), asc(sessionEvents.id));
    return rows.map((row) => parseStoredSessionLogEntry(row.payloadJson));
  }

  async listRecentMessages(scope: StoreScope, sessionId: string, limit: number, offset?: number): Promise<MessageRow[]> {
    const rows = await this.db.execute<{ ts: string; role: string; content: string }>(sql`
      SELECT ts, event_type AS role, content FROM (
        SELECT ts, event_type, content, id
        FROM session_events
        WHERE agent_id = ${scope.agentId} AND session_id = ${sessionId} AND event_type IN ('user', 'assistant', 'error')
        ORDER BY id DESC
        LIMIT ${limit} OFFSET ${offset ?? 0}
      ) sub ORDER BY id ASC
    `);
    return rows.rows.map((row) => ({
      ts: row.ts,
      role: row.role as 'user' | 'assistant' | 'error',
      content: row.content,
    }));
  }

  async listSessionEntriesSinceLastCompaction(
    scope: StoreScope,
    sessionId: string,
  ): Promise<{ compactionSummary: string | undefined; entries: SessionLogEntry[] }> {
    const [compactionRow] = await this.db.select({ id: sessionEvents.id, payloadJson: sessionEvents.payloadJson })
      .from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.eventType, 'context_compaction'),
      ))
      .orderBy(desc(sessionEvents.id))
      .limit(1);

    const afterId = compactionRow?.id ?? 0;
    let compactionSummary: string | undefined;
    if (compactionRow) {
      const parsed = JSON.parse(compactionRow.payloadJson) as Record<string, unknown>;
      compactionSummary = typeof parsed.content === 'string' ? parsed.content : undefined;
    }

    const rows = await this.db.select({ payloadJson: sessionEvents.payloadJson }).from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        gt(sessionEvents.id, afterId),
      ))
      .orderBy(asc(sessionEvents.id));

    return {
      compactionSummary,
      entries: rows.map((row) => parseStoredSessionLogEntry(row.payloadJson)),
    };
  }

  async getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ workingMemory: sessions.workingMemory }).from(sessions)
      .where(and(eq(sessions.agentId, scope.agentId), eq(sessions.sessionId, sessionId)));
    return row?.workingMemory ?? undefined;
  }

  async setSessionWorkingMemory(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void> {
    await this.db.update(sessions).set({ workingMemory: content, workingMemoryUpdatedAt: updatedAt })
      .where(and(eq(sessions.agentId, scope.agentId), eq(sessions.sessionId, sessionId)));
  }

  async getCompactionSummary(scope: StoreScope, sessionId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ payloadJson: sessionEvents.payloadJson }).from(sessionEvents)
      .where(and(
        eq(sessionEvents.agentId, scope.agentId),
        eq(sessionEvents.sessionId, sessionId),
        eq(sessionEvents.eventType, 'context_compaction'),
      ))
      .orderBy(desc(sessionEvents.id))
      .limit(1);
    if (!row) return undefined;
    const parsed = JSON.parse(row.payloadJson) as Record<string, unknown>;
    return typeof parsed.content === 'string' ? parsed.content : undefined;
  }

  async setCompactionSummary(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void> {
    await this.appendLogEntry(scope, sessionId, {
      ts: updatedAt,
      role: 'system',
      type: 'context_compaction',
      content,
    });
  }
}
