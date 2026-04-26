import type { SessionListQuery, SessionSummary } from '@openhermit/protocol';

import type { AuthContext } from './auth.js';

/**
 * Minimum surface of an `AgentRunner` we need to list sessions for a
 * caller. Defined here so tests can pass a stub.
 */
interface SessionListingRuntime {
  listSessions(
    query?: SessionListQuery,
    callerUserId?: string,
  ): Promise<SessionSummary[]>;
  resolveCallerUserId?(caller: {
    channel: string;
    channelUserId: string;
  }): Promise<string | undefined>;
}

/**
 * Single source of truth for "what sessions can this caller see?". Both
 * the HTTP handler (`GET /api/agents/:id/sessions`) and the WebSocket
 * `session.list` RPC route through this so they stay in lockstep.
 *
 * Auth-mode dispatch:
 *   - `admin`   — full agent visibility (management consoles).
 *   - `channel` — full agent visibility within the adapter's namespace
 *                 (caller can pre-set query.channel to constrain).
 *   - `user`    — strictly the caller's own participation. Owners are
 *                 *not* special here; agent tools (`session_list` /
 *                 `session_read`) widen visibility for owners
 *                 separately when run in-process.
 */
export const listSessionsForCaller = async (
  runtime: SessionListingRuntime,
  auth: AuthContext,
  query: SessionListQuery,
): Promise<SessionSummary[]> => {
  if (auth.mode === 'admin') {
    return runtime.listSessions(query);
  }

  if (auth.mode === 'channel') {
    const effectiveQuery: SessionListQuery = { ...query };
    if (auth.channelNamespace && !effectiveQuery.channel) {
      effectiveQuery.channel = auth.channelNamespace;
    }
    return runtime.listSessions(effectiveQuery);
  }

  // user mode
  if (!runtime.resolveCallerUserId) return [];
  const callerUserId = await runtime.resolveCallerUserId({
    channel: auth.channel,
    channelUserId: auth.channelUserId,
  });
  if (!callerUserId) return [];
  return runtime.listSessions(query, callerUserId);
};
