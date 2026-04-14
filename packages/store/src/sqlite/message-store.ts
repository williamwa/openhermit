import type { DatabaseSync } from 'node:sqlite';
import type { SessionAttachment, SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';

import type { MessageStore } from '../interfaces.js';
import type {
  CheckpointHistoryRow,
  SessionLogEntry,
  StoreScope,
} from '../types.js';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const mapHistoryRowToMessage = (row: {
  ts: string;
  role: string;
  content: string;
  metadata_json: string;
}): SessionHistoryMessage => {
  const metadata = asRecord(JSON.parse(row.metadata_json || '{}'));

  if (row.role === 'user') {
    const message: SessionHistoryMessage = {
      ts: row.ts,
      role: 'user',
      content: row.content,
    };

    if (typeof metadata?.messageId === 'string') {
      message.messageId = metadata.messageId;
    }

    if (Array.isArray(metadata?.attachments)) {
      message.attachments = metadata.attachments as SessionAttachment[];
    }

    return message;
  }

  if (row.role === 'assistant') {
    const message: SessionHistoryMessage = {
      ts: row.ts,
      role: 'assistant',
      content: row.content,
    };

    if (typeof metadata?.provider === 'string') {
      message.provider = metadata.provider;
    }

    if (typeof metadata?.model === 'string') {
      message.model = metadata.model;
    }

    if (typeof metadata?.stopReason === 'string') {
      message.stopReason = metadata.stopReason;
    }

    return message;
  }

  return {
    ts: row.ts,
    role: 'error',
    content: row.content,
  };
};

const insertSessionLogEntry = (
  database: DatabaseSync,
  agentId: string,
  sessionId: string,
  entry: SessionLogEntry,
): void => {
  database
    .prepare(
      `INSERT INTO session_events(agent_id, session_id, ts, event_type, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      agentId,
      sessionId,
      entry.ts,
      entry.type ?? entry.role,
      JSON.stringify(entry),
    );

  if (entry.role === 'user' && typeof entry.content === 'string') {
    const metadata = {
      ...(typeof entry.messageId === 'string' ? { messageId: entry.messageId } : {}),
      ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments } : {}),
    };
    database
      .prepare(
        `INSERT INTO session_messages(agent_id, session_id, ts, role, content, metadata_json)
         VALUES (?, ?, ?, 'user', ?, ?)`,
      )
      .run(agentId, sessionId, entry.ts, entry.content, JSON.stringify(metadata));
    return;
  }

  if (entry.role === 'assistant' && typeof entry.content === 'string') {
    const metadata = {
      ...(typeof entry.provider === 'string' ? { provider: entry.provider } : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(typeof entry.stopReason === 'string' ? { stopReason: entry.stopReason } : {}),
    };
    database
      .prepare(
        `INSERT INTO session_messages(agent_id, session_id, ts, role, content, metadata_json)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
      )
      .run(agentId, sessionId, entry.ts, entry.content, JSON.stringify(metadata));
    return;
  }

  if (entry.role === 'error' && typeof entry.message === 'string') {
    database
      .prepare(
        `INSERT INTO session_messages(agent_id, session_id, ts, role, content, metadata_json)
         VALUES (?, ?, ?, 'error', ?, '{}')`,
      )
      .run(agentId, sessionId, entry.ts, entry.message);
  }
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

export class SqliteMessageStore implements MessageStore {
  constructor(private readonly database: DatabaseSync) {}

  async appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<void> {
    insertSessionLogEntry(this.database, scope.agentId, sessionId, entry);
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
    const rows = this.database
      .prepare(
        `SELECT ts, role, content, metadata_json
         FROM session_messages
         WHERE agent_id = ? AND session_id = ?
         ORDER BY ts DESC, id DESC`,
      )
      .all(scope.agentId, sessionId) as Array<{
      ts: string;
      role: string;
      content: string;
      metadata_json: string;
    }>;

    return rows.map(mapHistoryRowToMessage);
  }

  async listCheckpointHistory(
    scope: StoreScope,
    sessionId: string,
  ): Promise<CheckpointHistoryRow[]> {
    const rows = this.database
      .prepare(
        `SELECT ts, role, content
         FROM session_messages
         WHERE agent_id = ? AND session_id = ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(scope.agentId, sessionId) as Array<{ ts: string; role: string; content: string }>;

    return rows
      .filter(
        (
          row,
        ): row is { ts: string; role: 'user' | 'assistant' | 'error'; content: string } =>
          row.role === 'user' || row.role === 'assistant' || row.role === 'error',
      )
      .map((row) => ({
        ts: row.ts,
        role: row.role,
        content: row.content,
      }));
  }

  async listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT payload_json
         FROM session_events
         WHERE agent_id = ? AND session_id = ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(scope.agentId, sessionId) as Array<{ payload_json: string }>;

    return rows.map((row) => parseStoredSessionLogEntry(row.payload_json));
  }

  async listRecentMessages(
    scope: StoreScope,
    sessionId: string,
    limit: number,
    offset?: number,
  ): Promise<CheckpointHistoryRow[]> {
    const rows = this.database
      .prepare(
        `SELECT ts, role, content FROM (
           SELECT ts, role, content, id
           FROM session_messages
           WHERE agent_id = ? AND session_id = ?
           ORDER BY id DESC
           LIMIT ? OFFSET ?
         ) sub ORDER BY id ASC`,
      )
      .all(scope.agentId, sessionId, limit, offset ?? 0) as Array<{ ts: string; role: string; content: string }>;

    return rows
      .filter(
        (
          row,
        ): row is { ts: string; role: 'user' | 'assistant' | 'error'; content: string } =>
          row.role === 'user' || row.role === 'assistant' || row.role === 'error',
      )
      .map((row) => ({
        ts: row.ts,
        role: row.role,
        content: row.content,
      }));
  }

  async listSessionEntriesSinceLastCompaction(
    scope: StoreScope,
    sessionId: string,
  ): Promise<{ compactionSummary: string | undefined; entries: SessionLogEntry[] }> {
    // Find the last compaction event.
    const compactionRow = this.database
      .prepare(
        `SELECT id, payload_json FROM session_events
         WHERE agent_id = ? AND session_id = ? AND event_type = 'context_compaction'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(scope.agentId, sessionId) as { id: number; payload_json: string } | undefined;

    const afterId = compactionRow?.id ?? 0;
    let compactionSummary: string | undefined;

    if (compactionRow) {
      const parsed = JSON.parse(compactionRow.payload_json) as Record<string, unknown>;
      compactionSummary = typeof parsed.content === 'string' ? parsed.content : undefined;
    }

    // Load all entries after the compaction event (or from beginning).
    const rows = this.database
      .prepare(
        `SELECT payload_json FROM session_events
         WHERE agent_id = ? AND session_id = ? AND id > ?
         ORDER BY id ASC`,
      )
      .all(scope.agentId, sessionId, afterId) as Array<{ payload_json: string }>;

    return {
      compactionSummary,
      entries: rows.map((row) => parseStoredSessionLogEntry(row.payload_json)),
    };
  }

  async getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT working_memory
         FROM sessions
         WHERE agent_id = ? AND session_id = ?`,
      )
      .get(scope.agentId, sessionId) as { working_memory?: string } | undefined;

    return typeof row?.working_memory === 'string' ? row.working_memory : undefined;
  }

  async setSessionWorkingMemory(
    scope: StoreScope,
    sessionId: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    this.database
      .prepare(
        `UPDATE sessions
         SET working_memory = ?, working_memory_updated_at = ?
         WHERE agent_id = ? AND session_id = ?`,
      )
      .run(content, updatedAt, scope.agentId, sessionId);
  }

  async getCompactionSummary(scope: StoreScope, sessionId: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT payload_json FROM session_events
         WHERE agent_id = ? AND session_id = ? AND event_type = 'context_compaction'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(scope.agentId, sessionId) as { payload_json: string } | undefined;

    if (!row) {
      return undefined;
    }

    const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
    return typeof parsed.content === 'string' ? parsed.content : undefined;
  }

  async setCompactionSummary(
    scope: StoreScope,
    sessionId: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    insertSessionLogEntry(this.database, scope.agentId, sessionId, {
      ts: updatedAt,
      role: 'system',
      type: 'context_compaction',
      content,
    });
  }
}
