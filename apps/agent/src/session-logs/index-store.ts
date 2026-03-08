import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AgentWorkspace } from '../core/index.js';
import {
  deriveSessionIndexEntryFromLog,
  parseSessionIndexDocument,
} from './parsing.js';
import type {
  PersistedSessionIndexEntry,
  SessionIndexDocument,
} from './types.js';

const SESSION_INDEX_RELATIVE_PATH = 'sessions/index.json';

export class SessionIndexStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly workspace: AgentWorkspace) {}

  async waitForIdle(): Promise<void> {
    await this.writeQueue;
  }

  async list(): Promise<PersistedSessionIndexEntry[]> {
    await this.waitForIdle();
    return this.readSessions();
  }

  async get(sessionId: string): Promise<PersistedSessionIndexEntry | undefined> {
    const sessions = await this.list();
    return sessions.find((session) => session.sessionId === sessionId);
  }

  async upsert(entry: PersistedSessionIndexEntry): Promise<void> {
    await this.enqueueWrite(async () => {
      const document = await this.readDocument();
      const byId = new Map(
        document.sessions.map((session) => [session.sessionId, session]),
      );
      byId.set(entry.sessionId, entry);

      await this.writeDocument({
        version: 1,
        sessions: [...byId.values()].sort((left, right) =>
          right.lastActivityAt.localeCompare(left.lastActivityAt),
        ),
      });
    });
  }

  private async enqueueWrite(work: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private async readSessions(): Promise<PersistedSessionIndexEntry[]> {
    const document = await this.readDocument();
    return document.sessions;
  }

  private async readDocument(): Promise<SessionIndexDocument> {
    try {
      const content = await this.workspace.readFile(SESSION_INDEX_RELATIVE_PATH);
      return parseSessionIndexDocument(JSON.parse(content) as unknown);
    } catch {
      return this.rebuildFromSessionLogs();
    }
  }

  private async writeDocument(document: SessionIndexDocument): Promise<void> {
    await this.workspace.writeFile(
      SESSION_INDEX_RELATIVE_PATH,
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }

  private async rebuildFromSessionLogs(): Promise<SessionIndexDocument> {
    const sessionsDir = await this.workspace.resolve('sessions');
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    const sessions: PersistedSessionIndexEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const sessionLogRelativePath = path.posix.join('sessions', entry.name);
      const content = await this.workspace.readFile(sessionLogRelativePath).catch(() => '');
      const rebuilt = deriveSessionIndexEntryFromLog(sessionLogRelativePath, content);

      if (rebuilt) {
        sessions.push(rebuilt);
      }
    }

    const document: SessionIndexDocument = {
      version: 1,
      sessions: sessions.sort((left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt),
      ),
    };

    await this.writeDocument(document);
    return document;
  }
}
