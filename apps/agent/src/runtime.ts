import {
  createAgentEndEvent,
  createTextFinalEvent,
  type OutboundEvent,
  type SessionListQuery,
  type SessionMessage,
  type SessionStatus,
  type SessionSummary,
  type SessionSpec,
} from '@cloudmind/protocol';
import { NotFoundError } from '@cloudmind/shared';

export interface SessionRecord {
  spec: SessionSpec;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  messageCount: number;
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
  postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }>;
}

const matchesSessionListQuery = (
  summary: SessionSummary,
  query: SessionListQuery,
): boolean => {
  if (query.kind && summary.source.kind !== query.kind) {
    return false;
  }

  if (query.platform && summary.source.platform !== query.platform) {
    return false;
  }

  if (
    query.interactive !== undefined &&
    summary.source.interactive !== query.interactive
  ) {
    return false;
  }

  return true;
};

const sortSessionSummaries = (
  left: SessionSummary,
  right: SessionSummary,
): number => right.lastActivityAt.localeCompare(left.lastActivityAt);

type SessionSubscriber = (
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
        messageCount: session.messageCount,
        ...(session.lastMessagePreview
          ? { lastMessagePreview: session.lastMessagePreview }
          : {}),
        status: session.status,
      }))
      .filter((summary) => matchesSessionListQuery(summary, query))
      .sort(sortSessionSummaries);

    return limit !== undefined ? summaries.slice(0, limit) : summaries;
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
    session.updatedAt = new Date().toISOString();
    session.status = 'running';
    session.messageCount += 1;
    session.lastMessagePreview = message.text;

    // Temporary scaffold response until the LLM loop is wired into the runtime.
    await this.events.publish(
      createTextFinalEvent(
        sessionId,
        `CloudMind agent scaffold received a ${session.spec.source.kind} message: ${message.text}`,
      ),
    );
    await this.events.publish(createAgentEndEvent(sessionId));
    session.updatedAt = new Date().toISOString();
    session.status = 'idle';
    session.messageCount += 1;
    session.lastMessagePreview = `CloudMind agent scaffold received a ${session.spec.source.kind} message: ${message.text}`;

    if (message.messageId) {
      return {
        sessionId,
        messageId: message.messageId,
      };
    }

    return { sessionId };
  }
}
