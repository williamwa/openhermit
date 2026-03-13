import type { DatabaseSync } from 'node:sqlite';

import type {
  EpisodicLogEntry,
  SessionLogEntry,
} from './types.js';
import { createSessionStartedEntries } from './types.js';
import type { SessionSpec } from '@openhermit/protocol';
import { insertSessionLogEntry, mapHistoryRowToMessage, parseStoredSessionLogEntry } from './sqlite-shared.js';

export class SessionLogWriter {
  constructor(
    private readonly database: DatabaseSync,
  ) {}

  async appendSession(sessionId: string, entry: SessionLogEntry): Promise<void> {
    insertSessionLogEntry(this.database, sessionId, entry);
  }

  async appendEpisodic(sessionId: string, entry: EpisodicLogEntry): Promise<void> {
    const checkpointData = entry.data;

    this.database
      .prepare(
        `INSERT INTO episodic_checkpoints(
          session_id,
          ts,
          checkpoint_type,
          reason,
          history_from,
          history_to,
          turn_count,
          summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        entry.ts,
        entry.type,
        String(checkpointData.reason ?? 'manual'),
        Number(checkpointData.fromHistoryCount ?? 0),
        Number(checkpointData.toHistoryCount ?? 0),
        Number(checkpointData.turnCount ?? 0),
        String(checkpointData.summary ?? ''),
      );
  }

  async writeSessionStarted(
    spec: SessionSpec,
    model: { provider: string; model: string },
  ): Promise<void> {
    const entries = createSessionStartedEntries(spec, model);

    await this.appendSession(spec.sessionId, entries.session);
  }

  async listHistoryMessages(sessionId: string) {
    const rows = this.database
      .prepare(
        `SELECT ts, role, content, metadata_json
         FROM session_messages
         WHERE session_id = ?
         ORDER BY ts DESC, id DESC`,
      )
      .all(sessionId) as Array<{
      ts: string;
      role: string;
      content: string;
      metadata_json: string;
    }>;

    return rows.map(mapHistoryRowToMessage);
  }

  async listCheckpointHistory(
    sessionId: string,
  ): Promise<Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>> {
    const rows = this.database
      .prepare(
        `SELECT ts, role, content
         FROM session_messages
         WHERE session_id = ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(sessionId) as Array<{ ts: string; role: string; content: string }>;

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

  async listSessionEntries(sessionId: string): Promise<SessionLogEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT payload_json
         FROM session_events
         WHERE session_id = ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(sessionId) as Array<{ payload_json: string }>;

    return rows.map((row) => parseStoredSessionLogEntry(row.payload_json));
  }

  async listEpisodicEntries(sessionId: string): Promise<EpisodicLogEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT
          ts,
          checkpoint_type,
          reason,
          history_from,
          history_to,
          turn_count,
          summary
         FROM episodic_checkpoints
         WHERE session_id = ?
         ORDER BY ts ASC, id ASC`,
      )
      .all(sessionId) as Array<{
      ts: string;
      checkpoint_type: string;
      reason: string;
      history_from: number;
      history_to: number;
      turn_count: number;
      summary: string;
    }>;

    return rows.map((row) => ({
      ts: row.ts,
      session: sessionId,
      type: row.checkpoint_type,
      data: {
        reason: row.reason,
        fromHistoryCount: row.history_from,
        toHistoryCount: row.history_to,
        turnCount: row.turn_count,
        summary: row.summary,
      },
    }));
  }

  async getSessionWorkingMemory(sessionId: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT working_memory
         FROM sessions
         WHERE session_id = ?`,
      )
      .get(sessionId) as { working_memory?: string } | undefined;

    return typeof row?.working_memory === 'string' ? row.working_memory : undefined;
  }

  async setSessionWorkingMemory(
    sessionId: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    this.database
      .prepare(
        `UPDATE sessions
         SET working_memory = ?, working_memory_updated_at = ?
         WHERE session_id = ?`,
      )
      .run(content, updatedAt, sessionId);
  }

  async getMemory(memoryKey: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT content
         FROM memories
         WHERE memory_key = ?`,
      )
      .get(memoryKey) as { content?: string } | undefined;

    return typeof row?.content === 'string' ? row.content : undefined;
  }

  async getMemoryEntry(memoryKey: string): Promise<{
    memoryKey: string;
    content: string;
    title?: string;
    tags?: string[];
    updatedAt: string;
  } | undefined> {
    const row = this.database
      .prepare(
        `SELECT memory_key, content, metadata_json, updated_at
         FROM memories
         WHERE memory_key = ?`,
      )
      .get(memoryKey) as {
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
    memoryKey: string,
    content: string,
    updatedAt: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO memories(memory_key, memory_kind, content, metadata_json, updated_at)
         VALUES (?, 'named', ?, ?, ?)
         ON CONFLICT(memory_key) DO UPDATE SET
           content = excluded.content,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(memoryKey, content, JSON.stringify(metadata), updatedAt);
  }

  async getMainMemory(): Promise<string | undefined> {
    return this.getMemory('main');
  }

  async getNowMemory(): Promise<string | undefined> {
    return this.getMemory('now');
  }

  async recallLongTermMemories(
    query: string,
    limit: number,
    keyPrefix?: string,
  ): Promise<
    Array<{
      memoryKey: string;
      content: string;
      title?: string;
      tags?: string[];
      updatedAt: string;
    }>
  > {
    const term = `%${query.trim().toLowerCase()}%`;
    const prefix = keyPrefix?.trim() ? `${keyPrefix.trim()}%` : undefined;
    const rows = this.database
      .prepare(
        `SELECT memory_key, content, metadata_json, updated_at
         FROM memories
         WHERE (
             lower(memory_key) LIKE ?
             OR lower(content) LIKE ?
             OR lower(COALESCE(json_extract(metadata_json, '$.title'), '')) LIKE ?
           )
           AND (? IS NULL OR memory_key LIKE ?)
         ORDER BY updated_at DESC, memory_key ASC
         LIMIT ?`,
      )
      .all(term, term, term, prefix ?? null, prefix ?? null, limit) as Array<{
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

  async upsertLongTermMemory(input: {
    key: string;
    content: string;
    title?: string;
    tags?: string[];
    updatedAt: string;
    kind?: string;
  }): Promise<{
    memoryKey: string;
    content: string;
    title?: string;
    tags?: string[];
    updatedAt: string;
  }> {
    const metadata = {
      ...(input.title ? { title: input.title } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
    };

    this.database
      .prepare(
        `INSERT INTO memories(memory_key, memory_kind, content, metadata_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_key) DO UPDATE SET
           memory_kind = excluded.memory_kind,
           content = excluded.content,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
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
