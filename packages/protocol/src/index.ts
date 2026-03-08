export type KnownSourceKind = 'cli' | 'im' | 'heartbeat' | 'cron';

export type SourceKind = KnownSourceKind | (string & {});

export type MetadataValue = string | number | boolean;

export interface SessionSource {
  kind: SourceKind;
  interactive: boolean;
  platform?: string;
  triggerId?: string;
}

export interface SessionSpec {
  sessionId: string;
  source: SessionSource;
  metadata?: Record<string, MetadataValue>;
}

export interface SessionAttachment {
  type: string;
  url?: string;
  data?: string;
}

export interface SessionMessage {
  messageId?: string;
  text: string;
  attachments?: SessionAttachment[];
}

export type OutboundEvent =
  | { type: 'text_delta'; sessionId: string; text: string }
  | { type: 'text_final'; sessionId: string; text: string }
  | { type: 'tool_start'; sessionId: string; tool: string }
  | { type: 'error'; sessionId: string; message: string };

export const agentLocalRoutes = {
  health: '/health',
  sessions: '/sessions',
  sessionMessagesPattern: '/sessions/:sessionId/messages',
  sessionMessages: (sessionId: string): string =>
    `/sessions/${encodeURIComponent(sessionId)}/messages`,
  events: '/events',
  eventsUrl: (sessionId: string): string =>
    `/events?sessionId=${encodeURIComponent(sessionId)}`,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isMetadataValue = (value: unknown): value is MetadataValue =>
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isAttachment = (value: unknown): value is SessionAttachment => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.url !== undefined && typeof value.url !== 'string') {
    return false;
  }

  if (value.data !== undefined && typeof value.data !== 'string') {
    return false;
  }

  return true;
};

export const isSessionSpec = (value: unknown): value is SessionSpec => {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    return false;
  }

  if (!isRecord(value.source)) {
    return false;
  }

  if (
    typeof value.source.kind !== 'string' ||
    typeof value.source.interactive !== 'boolean'
  ) {
    return false;
  }

  if (
    value.source.platform !== undefined &&
    typeof value.source.platform !== 'string'
  ) {
    return false;
  }

  if (
    value.source.triggerId !== undefined &&
    typeof value.source.triggerId !== 'string'
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

export const isSessionMessage = (value: unknown): value is SessionMessage => {
  if (!isRecord(value) || typeof value.text !== 'string') {
    return false;
  }

  if (value.messageId !== undefined && typeof value.messageId !== 'string') {
    return false;
  }

  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) {
      return false;
    }

    return value.attachments.every(isAttachment);
  }

  return true;
};

export const createTextFinalEvent = (
  sessionId: string,
  text: string,
): OutboundEvent => ({
  type: 'text_final',
  sessionId,
  text,
});
