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

  async getGlobalWorkingMemory(): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT content
         FROM memories
         WHERE memory_key = 'working:global'`,
      )
      .get() as { content?: string } | undefined;

    return typeof row?.content === 'string' ? row.content : undefined;
  }

  async setGlobalWorkingMemory(
    content: string,
    updatedAt: string,
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO memories(memory_key, memory_kind, content, metadata_json, updated_at)
         VALUES ('working:global', 'working', ?, '{}', ?)
         ON CONFLICT(memory_key) DO UPDATE SET
           content = excluded.content,
           updated_at = excluded.updated_at`,
      )
      .run(content, updatedAt);
  }
}
