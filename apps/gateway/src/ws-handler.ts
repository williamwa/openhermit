import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  isSessionSpec,
  isSessionMessage,
  isToolApprovalRequest,
  isSessionCheckpointRequest,
  isWsRequest,
  type WsRequest,
  type WsResponseOk,
  type WsResponseError,
  type WsErrorCode,
  type WsEvent,
  type WsServerMessage,
  type SessionListQuery,
} from '@openhermit/protocol';

import type { AgentRunner, SessionEventEnvelope } from '@openhermit/agent/agent-runner';

import type { AgentInstanceManager } from './agent-instance.js';
import type { AuthContext, AuthResolverOptions } from './auth.js';
import { resolveAuth } from './auth.js';

const WS_PING_INTERVAL_MS = 30_000;

interface WsConnection {
  ws: WebSocket;
  subscriptions: Map<string, () => void>; // sessionId → unsubscribe
  pingTimer: ReturnType<typeof setInterval>;
  auth?: AuthContext;
}

const sendJson = (ws: WebSocket, message: WsServerMessage): void => {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(message));
  }
};

const sendResult = (ws: WebSocket, id: string, result: unknown): void => {
  sendJson(ws, { kind: 'response', id, result } as WsResponseOk);
};

const sendError = (
  ws: WebSocket,
  id: string,
  code: WsErrorCode,
  message: string,
): void => {
  sendJson(ws, { kind: 'response', id, error: { code, message } } as WsResponseError);
};

const sendEvent = (ws: WebSocket, envelope: SessionEventEnvelope): void => {
  sendJson(ws, {
    kind: 'event',
    eventId: envelope.id,
    sessionId: envelope.event.sessionId,
    event: envelope.event,
  } as WsEvent);
};

const handleRequest = async (
  conn: WsConnection,
  request: WsRequest,
  runtime: AgentRunner,
): Promise<void> => {
  const { ws } = conn;
  const { id, method, params } = request;
  const p = (params ?? {}) as Record<string, unknown>;

  try {
    switch (method) {
      case 'session.open': {
        if (!isSessionSpec(p)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid SessionSpec params.');
          return;
        }
        // Inject authenticated identity into session metadata
        if (conn.auth?.mode === 'user' && conn.auth.channelUserId) {
          p.metadata = { ...(p.metadata as Record<string, unknown> ?? {}), username: conn.auth.channelUserId };
        }
        const session = await runtime.openSession(p);
        sendResult(ws, id, { sessionId: session.spec.sessionId });
        return;
      }

      case 'session.message': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        const message = {
          text: p.text,
          ...(p.messageId !== undefined ? { messageId: p.messageId } : {}),
          ...(p.attachments !== undefined ? { attachments: p.attachments } : {}),
          ...(p.sender !== undefined ? { sender: p.sender } : {}),
        };
        if (!isSessionMessage(message)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid message params.');
          return;
        }
        const result = await runtime.postMessage(sessionId, message);
        sendResult(ws, id, result);
        return;
      }

      case 'session.approve': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        const approval = { toolCallId: p.toolCallId, approved: p.approved };
        if (!isToolApprovalRequest(approval)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid approval params.');
          return;
        }
        const resolved = runtime.respondToApproval(
          sessionId,
          approval.toolCallId,
          approval.approved,
        );
        sendResult(ws, id, { resolved });
        return;
      }

      case 'session.checkpoint': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        const body = { reason: p.reason };
        if (!isSessionCheckpointRequest(body)) {
          sendError(ws, id, 'INVALID_PARAMS', 'Invalid checkpoint params.');
          return;
        }
        const checkpointed = await runtime.checkpointSession(
          sessionId,
          (body.reason as 'manual' | 'new_session' | 'turn_limit' | 'idle') ?? 'manual',
        );
        sendResult(ws, id, { checkpointed });
        return;
      }

      case 'session.list': {
        const query: SessionListQuery = {};
        if (typeof p.kind === 'string') query.kind = p.kind;
        if (typeof p.platform === 'string') query.platform = p.platform;
        if (typeof p.interactive === 'boolean') query.interactive = p.interactive;
        if (typeof p.limit === 'number') query.limit = p.limit;
        if (!conn.auth) { sendResult(ws, id, []); return; }
        const callerUserId = await runtime.resolveCallerUserId({ channel: conn.auth.channel, channelUserId: conn.auth.channelUserId });
        if (!callerUserId) { sendResult(ws, id, []); return; }
        sendResult(ws, id, await runtime.listSessions(query, callerUserId));
        return;
      }

      case 'session.history': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        if (!conn.auth) { sendError(ws, id, 'INVALID_PARAMS', 'Session not found.'); return; }
        const historyCallerUserId = await runtime.resolveCallerUserId({ channel: conn.auth.channel, channelUserId: conn.auth.channelUserId });
        if (!historyCallerUserId) { sendError(ws, id, 'INVALID_PARAMS', 'Session not found.'); return; }
        sendResult(ws, id, await runtime.listSessionMessages(sessionId, historyCallerUserId));
        return;
      }

      case 'session.subscribe': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        conn.subscriptions.get(sessionId)?.();
        const afterEventId = typeof p.lastEventId === 'number' ? p.lastEventId : 0;
        const unsubscribe = runtime.events.subscribeFrom(
          sessionId,
          afterEventId,
          (envelope) => sendEvent(ws, envelope),
        );
        conn.subscriptions.set(sessionId, unsubscribe);
        sendResult(ws, id, { subscribed: true });
        return;
      }

      case 'session.unsubscribe': {
        const sessionId = p.sessionId;
        if (typeof sessionId !== 'string') {
          sendError(ws, id, 'INVALID_PARAMS', 'Missing sessionId.');
          return;
        }
        const unsub = conn.subscriptions.get(sessionId);
        if (!unsub) {
          sendError(ws, id, 'NOT_SUBSCRIBED', `Not subscribed to session: ${sessionId}`);
          return;
        }
        unsub();
        conn.subscriptions.delete(sessionId);
        sendResult(ws, id, { unsubscribed: true });
        return;
      }

      default:
        sendError(ws, id, 'INVALID_PARAMS', `Unknown method: ${method}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(ws, id, 'INTERNAL_ERROR', message);
  }
};

export interface GatewayWsOptions {
  instances: AgentInstanceManager;
  auth?: AuthResolverOptions;
  logger?: (message: string) => void;
}

/**
 * Attach a WebSocket handler to the gateway HTTP server.
 *
 * Handles `upgrade` requests on `/agents/:agentId/ws`. Resolves the
 * AgentRunner from AgentInstanceManager and runs the WS RPC protocol
 * directly in-process (no proxy).
 */
export const attachGatewayWs = (
  httpServer: HttpServer,
  options: GatewayWsOptions,
): WebSocketServer => {
  const { instances } = options;
  const log = options.logger ?? (() => {});
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    // Match /agents/:agentId/ws
    const match = url.pathname.match(/^\/agents\/([^/]+)\/ws$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const agentId = decodeURIComponent(match[1]!);
    const runner = instances.getRunner(agentId);

    if (!runner) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    // Resolve auth from the upgrade request headers.
    let auth: AuthContext | undefined;
    if (options.auth) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const fakeRequest = new Request(`http://${request.headers.host ?? 'localhost'}${request.url ?? '/'}`, { headers });
      const resolved = await resolveAuth(fakeRequest, options.auth);
      if (resolved) auth = resolved;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      log(`[ws] client connected for agent ${agentId}${auth ? ` (${auth.mode}:${auth.channelUserId || 'channel'})` : ''}`);

      const conn: WsConnection = {
        ws,
        subscriptions: new Map(),
        pingTimer: setInterval(() => {
          if (ws.readyState === ws.OPEN) {
            ws.ping();
          }
        }, WS_PING_INTERVAL_MS),
        ...(auth ? { auth } : {}),
      };

      ws.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          sendError(ws, '', 'INVALID_PARAMS', 'Invalid JSON.');
          return;
        }

        if (!isWsRequest(parsed)) {
          sendError(ws, '', 'INVALID_PARAMS', 'Invalid WsRequest envelope.');
          return;
        }

        void handleRequest(conn, parsed, runner);
      });

      ws.on('close', () => {
        clearInterval(conn.pingTimer);
        for (const unsub of conn.subscriptions.values()) {
          unsub();
        }
        conn.subscriptions.clear();
      });

      ws.on('error', () => {
        ws.close();
      });
    });
  });

  return wss;
};
