import { randomUUID } from 'node:crypto';

import type { SessionSummary } from '@openhermit/protocol';
import { AgentLocalClient } from '@openhermit/sdk';

import { CLI_SESSION_LIMIT } from './constants.js';
import type { ChatCliOptions, StartupSessionSelection } from './types.js';

export const createSessionId = (): string =>
  `cli:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

export const createCliSessionSpec = (sessionId: string) => ({
  sessionId,
  source: {
    kind: 'cli' as const,
    interactive: true,
  },
});

export const listCliSessions = async (
  client: AgentLocalClient,
  limit = CLI_SESSION_LIMIT,
): Promise<SessionSummary[]> =>
  client.listSessions({
    kind: 'cli',
    limit,
  });

export const findCliSession = async (
  client: AgentLocalClient,
  sessionId: string,
): Promise<SessionSummary | undefined> => {
  const sessions = await client.listSessions({ kind: 'cli' });
  return sessions.find((session) => session.sessionId === sessionId);
};

export const selectStartupSession = (
  options: Pick<ChatCliOptions, 'sessionId' | 'resume'>,
  sessions: SessionSummary[],
  createSession: () => string = createSessionId,
): StartupSessionSelection => {
  if (options.sessionId) {
    const existing = sessions.find((session) => session.sessionId === options.sessionId);

    return {
      sessionId: options.sessionId,
      lastEventId: existing?.lastEventId ?? 0,
      resumed: Boolean(existing),
    };
  }

  if (options.resume) {
    const latest = sessions[0];

    if (latest) {
      return {
        sessionId: latest.sessionId,
        lastEventId: latest.lastEventId,
        resumed: true,
      };
    }
  }

  return {
    sessionId: createSession(),
    lastEventId: 0,
    resumed: false,
  };
};
