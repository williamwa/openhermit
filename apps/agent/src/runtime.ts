import {
  createAgentEndEvent,
  createTextFinalEvent,
  type OutboundEvent,
  type SessionHistoryMessage,
  type SessionListQuery,
  type SessionMessage,
  type SessionStatus,
  type SessionSummary,
  type SessionSpec,
} from '@openhermit/protocol';
import { NotFoundError } from '@openhermit/shared';

import {
  createFallbackDescription,
  matchesSessionListQuery,
  sortSessionSummaries,
} from './session-utils.js';

export interface SessionRecord {
  spec: SessionSpec;
  messages: SessionMessage[];
  history: SessionHistoryMessage[];
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messageCount: number;
  description?: string;
  lastMessagePreview?: string;
}

export interface SessionEventEnvelope {
  id: number;
  event: OutboundEvent;
}

export interface SessionDescriptor {
  spec: SessionSpec;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRuntime {
  readonly events: SessionEventBroker;
  openSession(spec: SessionSpec): Promise<SessionDescriptor>;
  listSessions(query?: SessionListQuery): Promise<SessionSummary[]>;
  listSessionMessages(sessionId: string): Promise<SessionHistoryMessage[]>;
  checkpointSession(
    sessionId: string,
    reason?: 'manual' | 'new_session' | 'turn_limit' | 'idle',
  ): Promise<boolean>;
  postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }>;
}

export type SessionSubscriber = (
  envelope: SessionEventEnvelope,
) => void | Promise<void>;

export class SessionEventBroker {
  private readonly subscribers = new Map<string, Set<SessionSubscriber>>();

  private readonly backlog = new Map<string, SessionEventEnvelope[]>();

  private nextEventId = 1;

  subscribe(sessionId: string, subscriber: SessionSubscriber): () => void {
    const sessionSubscribers =
      this.subscribers.get(sessionId) ?? new Set<SessionSubscriber>();
    sessionSubscribers.add(subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    return () => {
      const currentSubscribers = this.subscribers.get(sessionId);

      if (!currentSubscribers) {
        return;
      }

      currentSubscribers.delete(subscriber);

      if (currentSubscribers.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  getBacklog(sessionId: string): SessionEventEnvelope[] {
    return this.backlog.get(sessionId) ?? [];
  }

  /**
   * Atomically subscribe and replay backlog events with id > afterEventId.
   * Eliminates the race between getBacklog() and subscribe().
   */
  subscribeFrom(
    sessionId: string,
    afterEventId: number,
    subscriber: SessionSubscriber,
  ): () => void {
    const unsubscribe = this.subscribe(sessionId, subscriber);
    const backlog = this.backlog.get(sessionId) ?? [];
    for (const envelope of backlog) {
      if (envelope.id > afterEventId) {
        void subscriber(envelope);
      }
    }
    return unsubscribe;
  }

  async publish(event: OutboundEvent): Promise<void> {
    const envelope: SessionEventEnvelope = {
      id: this.nextEventId,
      event,
    };
    this.nextEventId += 1;

    const sessionBacklog = this.backlog.get(event.sessionId) ?? [];
    sessionBacklog.push(envelope);
    this.backlog.set(event.sessionId, sessionBacklog.slice(-100));

    const sessionSubscribers = this.subscribers.get(event.sessionId);

    if (!sessionSubscribers) {
      return;
    }

    for (const subscriber of sessionSubscribers) {
      await subscriber(envelope);
    }
  }
}

export class InMemoryAgentRuntime implements SessionRuntime {
  readonly events = new SessionEventBroker();

  private readonly sessions = new Map<string, SessionRecord>();

  async openSession(spec: SessionSpec): Promise<SessionDescriptor> {
    const now = new Date().toISOString();
    const existing = this.sessions.get(spec.sessionId);

    if (existing) {
      const mergedMetadata = {
        ...(existing.spec.metadata ?? {}),
        ...(spec.metadata ?? {}),
      };
      existing.spec = {
        ...existing.spec,
        ...spec,
        source: {
          ...existing.spec.source,
          ...spec.source,
        },
        ...(Object.keys(mergedMetadata).length > 0
          ? { metadata: mergedMetadata }
          : {}),
      };
      existing.updatedAt = now;
      return {
        spec: existing.spec,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }

    const session: SessionRecord = {
      spec,
      messages: [],
      history: [],
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      messageCount: 0,
    };

    this.sessions.set(spec.sessionId, session);
    return {
      spec: session.spec,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  async listSessions(query: SessionListQuery = {}): Promise<SessionSummary[]> {
    const limit = query.limit;
    const summaries = [...this.sessions.values()]
      .map((session) => ({
        sessionId: session.spec.sessionId,
        source: session.spec.source,
        createdAt: session.createdAt,
        lastActivityAt: session.updatedAt,
        lastEventId:
          this.events.getBacklog(session.spec.sessionId).at(-1)?.id ?? 0,
        messageCount: session.messageCount,
        ...(session.description ? { description: session.description } : {}),
        ...(session.lastMessagePreview
          ? { lastMessagePreview: session.lastMessagePreview }
          : {}),
        status: session.status,
      }))
      .filter((summary) => matchesSessionListQuery(summary, query))
      .sort(sortSessionSummaries);

    return limit !== undefined ? summaries.slice(0, limit) : summaries;
  }

  async listSessionMessages(sessionId: string): Promise<SessionHistoryMessage[]> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return [...session.history].reverse();
  }

  async checkpointSession(_sessionId: string): Promise<boolean> {
    return false;
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    session.messages.push(message);
    session.history.push({
      ts: session.updatedAt,
      role: 'user',
      content: message.text,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.attachments ? { attachments: message.attachments } : {}),
    });
    session.updatedAt = new Date().toISOString();
    session.status = 'running';
    session.messageCount += 1;
    if (!session.description) {
      const fallbackDescription = createFallbackDescription(message.text);

      if (fallbackDescription) {
        session.description = fallbackDescription;
      }
    }
    session.lastMessagePreview = message.text;

    // Temporary scaffold response until the LLM loop is wired into the runtime.
    await this.events.publish(
      createTextFinalEvent(
        sessionId,
        `OpenHermit agent scaffold received a ${session.spec.source.kind} message: ${message.text}`,
      ),
    );
    await this.events.publish(createAgentEndEvent(sessionId));
    session.updatedAt = new Date().toISOString();
    session.status = 'idle';
    session.messageCount += 1;
    const assistantText = `OpenHermit agent scaffold received a ${session.spec.source.kind} message: ${message.text}`;
    session.lastMessagePreview = assistantText;
    session.history.push({
      ts: session.updatedAt,
      role: 'assistant',
      content: assistantText,
    });

    if (message.messageId) {
      return {
        sessionId,
        messageId: message.messageId,
      };
    }

    return { sessionId };
  }
}
