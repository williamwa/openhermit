import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  MetadataValue,
  SessionSource,
  SessionSpec,
} from '@cloudmind/protocol';

import { AgentWorkspace } from './core/index.js';

export interface SessionLogEntry {
  ts: string;
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error';
  type?: string;
  [key: string]: unknown;
}

export interface EpisodicLogEntry {
  ts: string;
  session: string;
  type: string;
  data: Record<string, unknown>;
}

export interface SessionLogPaths {
  sessionLogRelativePath: string;
  episodicRelativePath: string;
}

export interface PersistedSessionIndexEntry {
  sessionId: string;
  source: SessionSource;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
  sessionLogRelativePath: string;
  episodicRelativePath: string;
  metadata?: Record<string, MetadataValue>;
}

interface SessionIndexDocument {
  version: 1;
  sessions: PersistedSessionIndexEntry[];
}

interface StartedSessionLogEntry extends Record<string, unknown> {
  ts: string;
  role: 'system';
  type: 'session_started';
  sessionId: string;
  source: SessionSource;
  metadata?: Record<string, MetadataValue>;
}

const SESSION_INDEX_RELATIVE_PATH = 'sessions/index.json';

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

const sanitizeSessionId = (sessionId: string): string =>
  sessionId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'session';

export const createSessionLogPaths = (
  sessionId: string,
  createdAt: string,
): SessionLogPaths => ({
  sessionLogRelativePath: `sessions/${createdAt.slice(0, 10)}-${sanitizeSessionId(sessionId)}.jsonl`,
  episodicRelativePath: `memory/episodic/${createdAt.slice(0, 7)}.jsonl`,
});

const createEmptySessionIndexDocument = (): SessionIndexDocument => ({
  version: 1,
  sessions: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMetadataValue = (value: unknown): value is MetadataValue =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isSessionSource = (value: unknown): value is SessionSource =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  typeof value.interactive === 'boolean' &&
  (value.platform === undefined || typeof value.platform === 'string') &&
  (value.triggerId === undefined || typeof value.triggerId === 'string');

const isStartedSessionLogEntry = (
  value: unknown,
): value is StartedSessionLogEntry => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.role !== 'system' ||
    value.type !== 'session_started' ||
    typeof value.ts !== 'string' ||
    typeof value.sessionId !== 'string' ||
    !isSessionSource(value.source)
  ) {
    return false;
  }

  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) {
      return false;
    }

    for (const metadataValue of Object.values(value.metadata)) {
      if (!isMetadataValue(metadataValue)) {
        return false;
      }
    }
  }

  return true;
};

const parseSessionIndexDocument = (value: unknown): SessionIndexDocument => {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    return createEmptySessionIndexDocument();
  }

  const sessions = value.sessions.filter((entry): entry is PersistedSessionIndexEntry => {
    if (!isRecord(entry)) {
      return false;
    }

    if (
      typeof entry.sessionId !== 'string' ||
      !isSessionSource(entry.source) ||
      typeof entry.createdAt !== 'string' ||
      typeof entry.lastActivityAt !== 'string' ||
      typeof entry.messageCount !== 'number' ||
      typeof entry.sessionLogRelativePath !== 'string' ||
      typeof entry.episodicRelativePath !== 'string'
    ) {
      return false;
    }

    if (
      entry.description !== undefined &&
      typeof entry.description !== 'string'
    ) {
      return false;
    }

    if (
      entry.descriptionSource !== undefined &&
      entry.descriptionSource !== 'fallback' &&
      entry.descriptionSource !== 'ai'
    ) {
      return false;
    }

    if (
      entry.lastMessagePreview !== undefined &&
      typeof entry.lastMessagePreview !== 'string'
    ) {
      return false;
    }

    if (entry.metadata !== undefined) {
      if (!isRecord(entry.metadata)) {
        return false;
      }

      for (const metadataValue of Object.values(entry.metadata)) {
        if (!isMetadataValue(metadataValue)) {
          return false;
        }
      }
    }

    return true;
  });

  return {
    version: 1,
    sessions,
  };
};

const deriveSessionIndexEntryFromLog = (
  sessionLogRelativePath: string,
  content: string,
): PersistedSessionIndexEntry | undefined => {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return undefined;
  }

  const entries = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(isRecord);
  const startedEntry = entries.find(isStartedSessionLogEntry);

  if (!startedEntry) {
    return undefined;
  }

  let messageCount = 0;
  let firstUserMessage: string | undefined;
  let lastMessagePreview: string | undefined;
  let lastActivityAt = startedEntry.ts;

  for (const entry of entries) {
    if (typeof entry.ts === 'string') {
      lastActivityAt = entry.ts;
    }

    if (
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.content === 'string'
    ) {
      if (entry.role === 'user' && !firstUserMessage) {
        firstUserMessage = entry.content;
      }

      messageCount += 1;
      lastMessagePreview = entry.content;
    }
  }

  const metadata = isRecord(startedEntry.metadata)
    ? (startedEntry.metadata as Record<string, MetadataValue>)
    : undefined;

  return {
    sessionId: startedEntry.sessionId,
    source: startedEntry.source,
    createdAt: startedEntry.ts,
    lastActivityAt,
    messageCount,
    ...(firstUserMessage
      ? {
          description: firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 80),
          descriptionSource: 'fallback' as const,
        }
      : {}),
    ...(lastMessagePreview ? { lastMessagePreview } : {}),
    sessionLogRelativePath,
    episodicRelativePath: `memory/episodic/${startedEntry.ts.slice(0, 7)}.jsonl`,
    ...(metadata ? { metadata } : {}),
  };
};

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

export class SessionLogWriter {
  constructor(private readonly workspace: AgentWorkspace) {}

  async appendSession(relativePath: string, entry: SessionLogEntry): Promise<void> {
    await appendJsonl(this.workspace, relativePath, entry);
  }

  async appendEpisodic(relativePath: string, entry: EpisodicLogEntry): Promise<void> {
    await appendJsonl(this.workspace, relativePath, entry);
  }

  async writeSessionStarted(
    paths: SessionLogPaths,
    spec: SessionSpec,
    model: { provider: string; model: string },
  ): Promise<void> {
    const ts = new Date().toISOString();

    await Promise.all([
      this.appendSession(paths.sessionLogRelativePath, {
        ts,
        role: 'system',
        type: 'session_started',
        sessionId: spec.sessionId,
        source: spec.source,
        ...(spec.metadata ? { metadata: spec.metadata } : {}),
        model,
      }),
      this.appendEpisodic(paths.episodicRelativePath, {
        ts,
        session: spec.sessionId,
        type: 'session_started',
        data: {
          source: spec.source,
          ...(spec.metadata ? { metadata: spec.metadata } : {}),
          model,
        },
      }),
    ]);
  }
}
