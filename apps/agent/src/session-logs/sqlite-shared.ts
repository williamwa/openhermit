import type { DatabaseSync } from 'node:sqlite';

import type { SessionAttachment, SessionHistoryMessage } from '@openhermit/protocol';

import type { SessionLogEntry } from './types.js';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

export const insertSessionLogEntry = (
  database: DatabaseSync,
  sessionId: string,
  entry: SessionLogEntry,
): void => {
  database
    .prepare(
      `INSERT INTO session_events(session_id, ts, event_type, payload_json)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      sessionId,
      entry.ts,
      entry.type ?? entry.role,
      JSON.stringify(entry),
    );

  if (entry.role === 'user' && typeof entry.content === 'string') {
    const metadata = {
      ...(typeof entry.messageId === 'string' ? { messageId: entry.messageId } : {}),
      ...(Array.isArray(entry.attachments) ? { attachments: entry.attachments } : {}),
    };
    database
      .prepare(
        `INSERT INTO session_messages(session_id, ts, role, content, metadata_json)
         VALUES (?, ?, 'user', ?, ?)`,
      )
      .run(sessionId, entry.ts, entry.content, JSON.stringify(metadata));
    return;
  }

  if (entry.role === 'assistant' && typeof entry.content === 'string') {
    const metadata = {
      ...(typeof entry.provider === 'string' ? { provider: entry.provider } : {}),
      ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(typeof entry.stopReason === 'string' ? { stopReason: entry.stopReason } : {}),
    };
    database
      .prepare(
        `INSERT INTO session_messages(session_id, ts, role, content, metadata_json)
         VALUES (?, ?, 'assistant', ?, ?)`,
      )
      .run(sessionId, entry.ts, entry.content, JSON.stringify(metadata));
    return;
  }

  if (entry.role === 'error' && typeof entry.message === 'string') {
    database
      .prepare(
        `INSERT INTO session_messages(session_id, ts, role, content, metadata_json)
         VALUES (?, ?, 'error', ?, '{}')`,
      )
      .run(sessionId, entry.ts, entry.message);
  }
};

export const mapHistoryRowToMessage = (row: {
  ts: string;
  role: string;
  content: string;
  metadata_json: string;
}): SessionHistoryMessage => {
  const metadata = asRecord(JSON.parse(row.metadata_json || '{}'));

  if (row.role === 'user') {
    const message: SessionHistoryMessage = {
      ts: row.ts,
      role: 'user',
      content: row.content,
    };

    if (typeof metadata?.messageId === 'string') {
      message.messageId = metadata.messageId;
    }

    if (Array.isArray(metadata?.attachments)) {
      message.attachments = metadata.attachments as SessionAttachment[];
    }

    return message;
  }

  if (row.role === 'assistant') {
    const message: SessionHistoryMessage = {
      ts: row.ts,
      role: 'assistant',
      content: row.content,
    };

    if (typeof metadata?.provider === 'string') {
      message.provider = metadata.provider;
    }

    if (typeof metadata?.model === 'string') {
      message.model = metadata.model;
    }

    if (typeof metadata?.stopReason === 'string') {
      message.stopReason = metadata.stopReason;
    }

    return message;
  }

  return {
    ts: row.ts,
    role: 'error',
    content: row.content,
  };
};

export const parseStoredSessionLogEntry = (payloadJson: string): SessionLogEntry =>
  JSON.parse(payloadJson) as SessionLogEntry;
