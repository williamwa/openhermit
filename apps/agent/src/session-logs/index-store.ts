import { promises as fs } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import type { MetadataValue } from '@openhermit/protocol';

import { AgentWorkspace } from '../core/index.js';
import {
  deriveSessionIndexEntryFromLog,
  parseSessionLogEntries,
  parseSessionIndexDocument,
} from './parsing.js';
import type {
  PersistedSessionIndexEntry,
} from './types.js';
import { insertSessionLogEntry } from './sqlite-shared.js';

export class SessionIndexStore {
  private writeQueue = Promise.resolve();

  private importedLegacyState = false;

  constructor(
    private readonly workspace: AgentWorkspace,
    private readonly database: DatabaseSync,
  ) {}

  async waitForIdle(): Promise<void> {
    await this.writeQueue;
  }

  async list(): Promise<PersistedSessionIndexEntry[]> {
    await this.waitForIdle();
    await this.ensureImportedLegacyState();
    return this.readSessions();
  }

  async get(sessionId: string): Promise<PersistedSessionIndexEntry | undefined> {
    const sessions = await this.list();
    return sessions.find((session) => session.sessionId === sessionId);
  }

  async upsert(entry: PersistedSessionIndexEntry): Promise<void> {
    await this.enqueueWrite(async () => {
      this.database
        .prepare(
          `INSERT INTO sessions(
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
            last_summarized_history_count,
            last_summarized_turn_count,
            last_summarized_at,
            last_message_preview,
            metadata_json,
            episodic_relative_path,
            status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            source_kind = excluded.source_kind,
            source_platform = excluded.source_platform,
            interactive = excluded.interactive,
            created_at = excluded.created_at,
            last_activity_at = excluded.last_activity_at,
            description = excluded.description,
            description_source = excluded.description_source,
            message_count = excluded.message_count,
            completed_turn_count = excluded.completed_turn_count,
            last_summarized_history_count = excluded.last_summarized_history_count,
            last_summarized_turn_count = excluded.last_summarized_turn_count,
            last_summarized_at = excluded.last_summarized_at,
            last_message_preview = excluded.last_message_preview,
            metadata_json = excluded.metadata_json,
            episodic_relative_path = excluded.episodic_relative_path,
            status = excluded.status`,
        )
        .run(
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
          entry.lastSummarizedHistoryCount ?? 0,
          entry.lastSummarizedTurnCount ?? 0,
          entry.lastSummarizedAt ?? null,
          entry.lastMessagePreview ?? null,
          JSON.stringify(entry.metadata ?? {}),
          entry.episodicRelativePath,
          'idle',
        );
    });
  }

  private async enqueueWrite(work: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async readSessions(): Promise<PersistedSessionIndexEntry[]> {
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
          last_summarized_history_count,
          last_summarized_turn_count,
          last_summarized_at,
          last_message_preview,
          metadata_json,
          episodic_relative_path
         FROM sessions
         ORDER BY last_activity_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

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
        lastSummarizedHistoryCount: Number(row.last_summarized_history_count),
        lastSummarizedTurnCount: Number(row.last_summarized_turn_count),
        episodicRelativePath: String(row.episodic_relative_path),
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

  private async ensureImportedLegacyState(): Promise<void> {
    if (this.importedLegacyState) {
      return;
    }
    this.importedLegacyState = true;

    const existing = this.database
      .prepare('SELECT COUNT(*) AS count FROM sessions')
      .get() as { count: number };

    if (existing.count > 0) {
      return;
    }

    await this.importLegacySessions();
  }

  private async importLegacySessions(): Promise<void> {
    let indexedSessions: PersistedSessionIndexEntry[] = [];

    try {
      const content = await this.workspace.readFile('sessions/index.json');
      indexedSessions = parseSessionIndexDocument(JSON.parse(content) as unknown).sessions;
    } catch {
      indexedSessions = [];
    }

    const sessionsDir = await this.workspace.resolve('sessions');
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    const sessions = new Map(indexedSessions.map((entry) => [entry.sessionId, entry]));

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const sessionLogRelativePath = path.posix.join('sessions', entry.name);
      const content = await this.workspace.readFile(sessionLogRelativePath).catch(() => '');
      const rebuilt = deriveSessionIndexEntryFromLog(content);

      if (rebuilt) {
        const existingEntry = sessions.get(rebuilt.sessionId);
        sessions.set(rebuilt.sessionId, existingEntry ? { ...rebuilt, ...existingEntry } : rebuilt);
      }

      const rawEntries = parseSessionLogEntries(content);
      const sessionId = rebuilt?.sessionId;

      if (!sessionId) {
        continue;
      }

      this.database.exec('BEGIN');
      try {
        const sessionEntry = sessions.get(sessionId);
        if (sessionEntry) {
          this.database
            .prepare(
              `INSERT OR IGNORE INTO sessions(
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
                last_summarized_history_count,
                last_summarized_turn_count,
                last_summarized_at,
                last_message_preview,
                metadata_json,
                episodic_relative_path,
                status
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle')`,
            )
            .run(
              sessionEntry.sessionId,
              sessionEntry.source.kind,
              sessionEntry.source.platform ?? null,
              sessionEntry.source.interactive ? 1 : 0,
              sessionEntry.createdAt,
              sessionEntry.lastActivityAt,
              sessionEntry.description ?? null,
              sessionEntry.descriptionSource ?? null,
              sessionEntry.messageCount,
              sessionEntry.completedTurnCount ?? 0,
              sessionEntry.lastSummarizedHistoryCount ?? 0,
              sessionEntry.lastSummarizedTurnCount ?? 0,
              sessionEntry.lastSummarizedAt ?? null,
              sessionEntry.lastMessagePreview ?? null,
              JSON.stringify(sessionEntry.metadata ?? {}),
              sessionEntry.episodicRelativePath,
            );
        }

        for (const rawEntry of rawEntries) {
          insertSessionLogEntry(this.database, sessionId, rawEntry);
        }

        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    for (const session of sessions.values()) {
      await this.upsert(session);
    }
  }
}
