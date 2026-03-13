import { promises as fs } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { AgentWorkspace } from '../core/index.js';
import type {
  EpisodicLogEntry,
  SessionLogEntry,
} from './types.js';
import { createSessionStartedEntries, type SessionLogPaths } from './types.js';
import type { SessionSpec } from '@openhermit/protocol';
import { insertSessionLogEntry, mapHistoryRowToMessage, parseStoredSessionLogEntry } from './sqlite-shared.js';

const ensureJsonlFile = async (
  workspace: AgentWorkspace,
  relativePath: string,
): Promise<string> => {
  const target = await workspace.resolve(relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
};

const appendJsonl = async (
  workspace: AgentWorkspace,
  relativePath: string,
  value: unknown,
): Promise<void> => {
  const target = await ensureJsonlFile(workspace, relativePath);
  await fs.appendFile(target, `${JSON.stringify(value)}\n`, 'utf8');
};

export class SessionLogWriter {
  constructor(
    private readonly workspace: AgentWorkspace,
    private readonly database: DatabaseSync,
  ) {}

  async appendSession(sessionId: string, entry: SessionLogEntry): Promise<void> {
    insertSessionLogEntry(this.database, sessionId, entry);
  }

  async appendEpisodic(relativePath: string, entry: EpisodicLogEntry): Promise<void> {
    await appendJsonl(this.workspace, relativePath, entry);
  }

  async writeSessionStarted(
    paths: SessionLogPaths,
    spec: SessionSpec,
    model: { provider: string; model: string },
  ): Promise<void> {
    const entries = createSessionStartedEntries(paths, spec, model);

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
}
