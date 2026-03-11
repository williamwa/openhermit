import type {
  MetadataValue,
  SessionAttachment,
  SessionHistoryMessage,
  SessionSource,
} from '@openhermit/protocol';

import {
  createEmptySessionIndexDocument,
  type PersistedSessionIndexEntry,
  type SessionIndexDocument,
  type StartedSessionLogEntry,
} from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMetadataValue = (value: unknown): value is MetadataValue =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isAttachment = (value: unknown): value is SessionAttachment =>
  isRecord(value) &&
  typeof value.type === 'string' &&
  (value.url === undefined || typeof value.url === 'string') &&
  (value.data === undefined || typeof value.data === 'string');

const isSessionSource = (value: unknown): value is SessionSource =>
  isRecord(value) &&
  typeof value.kind === 'string' &&
  typeof value.interactive === 'boolean' &&
  (value.platform === undefined || typeof value.platform === 'string') &&
  (value.triggerId === undefined || typeof value.triggerId === 'string');

const hasMeaningfulText = (value: string): boolean => value.trim().length > 0;

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

export const parseSessionIndexDocument = (value: unknown): SessionIndexDocument => {
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
      entry.completedTurnCount !== undefined &&
      typeof entry.completedTurnCount !== 'number'
    ) {
      return false;
    }

    if (
      entry.lastSummarizedHistoryCount !== undefined &&
      typeof entry.lastSummarizedHistoryCount !== 'number'
    ) {
      return false;
    }

    if (
      entry.lastSummarizedTurnCount !== undefined &&
      typeof entry.lastSummarizedTurnCount !== 'number'
    ) {
      return false;
    }

    if (
      entry.lastSummarizedAt !== undefined &&
      typeof entry.lastSummarizedAt !== 'string'
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

export const deriveSessionIndexEntryFromLog = (
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
      typeof entry.content === 'string' &&
      (entry.role !== 'assistant' || hasMeaningfulText(entry.content))
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
    completedTurnCount: Math.floor(messageCount / 2),
    lastSummarizedHistoryCount: 0,
    lastSummarizedTurnCount: 0,
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

export const parseSessionHistoryMessages = (
  content: string,
): SessionHistoryMessage[] => {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const history: SessionHistoryMessage[] = [];

  for (const line of lines) {
    const parsed = JSON.parse(line) as unknown;

    if (!isRecord(parsed) || typeof parsed.ts !== 'string') {
      continue;
    }

    if (
      parsed.role === 'user' &&
      typeof parsed.content === 'string'
    ) {
      history.push({
        ts: parsed.ts,
        role: 'user',
        content: parsed.content,
        ...(typeof parsed.messageId === 'string' ? { messageId: parsed.messageId } : {}),
        ...(Array.isArray(parsed.attachments) &&
        parsed.attachments.every(isAttachment)
          ? { attachments: parsed.attachments }
          : {}),
      });
      continue;
    }

    if (
      parsed.role === 'assistant' &&
      typeof parsed.content === 'string' &&
      hasMeaningfulText(parsed.content)
    ) {
      history.push({
        ts: parsed.ts,
        role: 'assistant',
        content: parsed.content,
        ...(typeof parsed.provider === 'string' ? { provider: parsed.provider } : {}),
        ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
        ...(typeof parsed.stopReason === 'string'
          ? { stopReason: parsed.stopReason }
          : {}),
      });
      continue;
    }

    if (parsed.role === 'error' && typeof parsed.message === 'string') {
      history.push({
        ts: parsed.ts,
        role: 'error',
        content: parsed.message,
      });
    }
  }

  return history.reverse();
};
