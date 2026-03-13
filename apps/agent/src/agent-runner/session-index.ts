import type { SessionListQuery, SessionSummary } from '@openhermit/protocol';

import type { PersistedSessionIndexEntry } from '../session-logs.js';
import { matchesSessionListQuery, sortSessionSummaries } from '../session-utils.js';
import type { RunnerSession } from './types.js';

export const createPersistedSessionIndexEntry = (
  session: RunnerSession,
): PersistedSessionIndexEntry => ({
  sessionId: session.spec.sessionId,
  source: session.spec.source,
  createdAt: session.createdAt,
  lastActivityAt: session.updatedAt,
  messageCount: session.messageCount,
  completedTurnCount: session.completedTurnCount,
  lastSummarizedHistoryCount: session.lastSummarizedHistoryCount,
  lastSummarizedTurnCount: session.lastSummarizedTurnCount,
  ...(session.lastSummarizedAt
    ? { lastSummarizedAt: session.lastSummarizedAt }
    : {}),
  ...(session.description ? { description: session.description } : {}),
  ...(session.descriptionSource
    ? { descriptionSource: session.descriptionSource }
    : {}),
  ...(session.lastMessagePreview
    ? { lastMessagePreview: session.lastMessagePreview }
    : {}),
  ...(session.spec.metadata ? { metadata: session.spec.metadata } : {}),
});

const createSessionSummary = (
  session: RunnerSession,
  lastEventId: number,
): SessionSummary => ({
  sessionId: session.spec.sessionId,
  source: session.spec.source,
  createdAt: session.createdAt,
  lastActivityAt: session.updatedAt,
  lastEventId,
  messageCount: session.messageCount,
  ...(session.description ? { description: session.description } : {}),
  ...(session.lastMessagePreview
    ? { lastMessagePreview: session.lastMessagePreview }
    : {}),
  status: session.status,
});

export const buildSessionSummaries = (
  persistedSessions: PersistedSessionIndexEntry[],
  activeSessions: Iterable<RunnerSession>,
  query: SessionListQuery,
  getLastEventId: (sessionId: string) => number,
): SessionSummary[] => {
  const activeById = new Map(
    [...activeSessions].map((session) => [session.spec.sessionId, session]),
  );

  const persistedSummaries = persistedSessions.map((session) => {
    const activeSession = activeById.get(session.sessionId);

    if (activeSession) {
      return createSessionSummary(
        activeSession,
        getLastEventId(activeSession.spec.sessionId),
      );
    }

    return {
      sessionId: session.sessionId,
      source: session.source,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      lastEventId: 0,
      messageCount: session.messageCount,
      ...(session.description ? { description: session.description } : {}),
      ...(session.lastMessagePreview
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
      status: 'idle' as const,
    };
  });

  const runtimeOnlySummaries = [...activeSessions]
    .filter(
      (session) =>
        !persistedSessions.some(
          (entry) => entry.sessionId === session.spec.sessionId,
        ),
    )
    .map((session) =>
      createSessionSummary(session, getLastEventId(session.spec.sessionId)),
    );

  return persistedSummaries
    .concat(runtimeOnlySummaries)
    .filter((summary) => matchesSessionListQuery(summary, query))
    .sort(sortSessionSummaries);
};
