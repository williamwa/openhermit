import type {
  MetadataValue,
  SessionSource,
  SessionSpec,
} from '@openhermit/protocol';

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
  episodicRelativePath: string;
}

export interface PersistedSessionIndexEntry {
  sessionId: string;
  source: SessionSource;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  completedTurnCount?: number;
  lastSummarizedHistoryCount?: number;
  lastSummarizedTurnCount?: number;
  lastSummarizedAt?: string;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
  episodicRelativePath: string;
  metadata?: Record<string, MetadataValue>;
}

export interface SessionIndexDocument {
  version: 1;
  sessions: PersistedSessionIndexEntry[];
}

export interface StartedSessionLogEntry extends Record<string, unknown> {
  ts: string;
  role: 'system';
  type: 'session_started';
  sessionId: string;
  source: SessionSource;
  metadata?: Record<string, MetadataValue>;
}

export const createEmptySessionIndexDocument = (): SessionIndexDocument => ({
  version: 1,
  sessions: [],
});

export const createSessionLogPaths = (
  createdAt: string,
): SessionLogPaths => ({
  episodicRelativePath: `memory/episodic/${createdAt.slice(0, 7)}.jsonl`,
});

export const createSessionStartedEntries = (
  paths: SessionLogPaths,
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
    paths,
  };
};
