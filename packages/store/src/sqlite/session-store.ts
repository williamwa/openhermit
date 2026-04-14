import type { DatabaseSync } from 'node:sqlite';
import type { MetadataValue } from '@openhermit/protocol';

import type { SessionStore } from '../interfaces.js';
import type { PersistedSessionIndexEntry, StoreScope } from '../types.js';

export class SqliteSessionStore implements SessionStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  async waitForIdle(): Promise<void> {
    await this.writeQueue;
  }

  async list(scope: StoreScope): Promise<PersistedSessionIndexEntry[]> {
    await this.waitForIdle();
    return this.readSessions(scope);
  }

  async get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined> {
    const sessions = await this.list(scope);
    return sessions.find((session) => session.sessionId === sessionId);
  }

  async upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void> {
    await this.enqueueWrite(async () => {
      this.database
        .prepare(
          `INSERT INTO sessions(
            agent_id,
            session_id,
            source_kind,
            source_platform,
            interactive,
            created_at,
            last_activity_at,
            description,
            description_source,
            message_count,
            completed_turn_count,
            last_introspection_event_id,
            last_summarized_turn_count,
            last_summarized_at,
            last_message_preview,
            metadata_json,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(agent_id, session_id) DO UPDATE SET
            source_kind = excluded.source_kind,
            source_platform = excluded.source_platform,
            interactive = excluded.interactive,
            created_at = excluded.created_at,
            last_activity_at = excluded.last_activity_at,
            description = excluded.description,
            description_source = excluded.description_source,
            message_count = excluded.message_count,
            completed_turn_count = excluded.completed_turn_count,
            last_introspection_event_id = excluded.last_introspection_event_id,
            last_summarized_turn_count = excluded.last_summarized_turn_count,
            last_summarized_at = excluded.last_summarized_at,
            last_message_preview = excluded.last_message_preview,
            metadata_json = excluded.metadata_json,
            status = excluded.status`,
        )
        .run(
          scope.agentId,
          entry.sessionId,
          entry.source.kind,
          entry.source.platform ?? null,
          entry.source.interactive ? 1 : 0,
          entry.createdAt,
          entry.lastActivityAt,
          entry.description ?? null,
          entry.descriptionSource ?? null,
          entry.messageCount,
          entry.completedTurnCount ?? 0,
          entry.lastIntrospectionEventId ?? 0,
          entry.lastSummarizedTurnCount ?? 0,
          entry.lastSummarizedAt ?? null,
          entry.lastMessagePreview ?? null,
          JSON.stringify(entry.metadata ?? {}),
          'idle',
        );
    });
  }

  async updateDescription(scope: StoreScope, sessionId: string, description: string, source: 'fallback' | 'ai'): Promise<void> {
    await this.enqueueWrite(async () => {
      this.database
        .prepare(
          `UPDATE sessions SET description = ?, description_source = ? WHERE agent_id = ? AND session_id = ?`,
        )
        .run(description, source, scope.agentId, sessionId);
    });
  }

  private async enqueueWrite(work: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private readSessions(scope: StoreScope): PersistedSessionIndexEntry[] {
    const rows = this.database
      .prepare(
        `SELECT
          session_id,
          source_kind,
          source_platform,
          interactive,
          created_at,
          last_activity_at,
          description,
          description_source,
          message_count,
          completed_turn_count,
          last_introspection_event_id,
          last_summarized_turn_count,
          last_summarized_at,
          last_message_preview,
          metadata_json
         FROM sessions
         WHERE agent_id = ?
         ORDER BY last_activity_at DESC`,
      )
      .all(scope.agentId) as Array<Record<string, unknown>>;

    return rows.map((row) => {
      const metadata = JSON.parse(String(row.metadata_json || '{}')) as Record<string, unknown>;
      const entry: PersistedSessionIndexEntry = {
        sessionId: String(row.session_id),
        source: {
          kind: String(row.source_kind),
          interactive: Number(row.interactive) === 1,
          ...(typeof row.source_platform === 'string'
            ? { platform: row.source_platform }
            : {}),
        },
        createdAt: String(row.created_at),
        lastActivityAt: String(row.last_activity_at),
        messageCount: Number(row.message_count),
        completedTurnCount: Number(row.completed_turn_count),
        lastIntrospectionEventId: Number(row.last_introspection_event_id),
        lastSummarizedTurnCount: Number(row.last_summarized_turn_count),
      };

      if (typeof row.last_summarized_at === 'string') {
        entry.lastSummarizedAt = row.last_summarized_at;
      }

      if (typeof row.description === 'string') {
        entry.description = row.description;
      }

      if (row.description_source === 'fallback' || row.description_source === 'ai') {
        entry.descriptionSource = row.description_source;
      }

      if (typeof row.last_message_preview === 'string') {
        entry.lastMessagePreview = row.last_message_preview;
      }

      if (Object.keys(metadata).length > 0) {
        entry.metadata = metadata as Record<string, MetadataValue>;
      }

      return entry;
    });
  }
}
