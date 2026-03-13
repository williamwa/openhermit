import type {
  MetadataValue,
  SessionAttachment,
  SessionHistoryMessage,
} from '@openhermit/protocol';

import {
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

const isSessionSource = (value: unknown): value is SessionIndexDocument['sessions'][number]['source'] =>
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
