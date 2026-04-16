import type { IncomingMessage } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer } from 'ws';

import type { AgentRegistry } from './agent-registry.js';
import type { AgentLifecycle } from './agent-lifecycle.js';

export interface WsProxyDeps {
  registry: AgentRegistry;
  lifecycle: AgentLifecycle;
  logger?: (message: string) => void;
}

/**
 * Attach a WebSocket proxy to the gateway HTTP server.
 *
 * Handles `upgrade` requests on `/agents/:agentId/ws`. Validates the gateway
 * token from the query string, resolves the agent's port and token, then
 * establishes a bidirectional WS frame proxy to the agent's `/ws` endpoint.
 */
export const attachGatewayWsProxy = (
  httpServer: HttpServer,
  deps: WsProxyDeps,
  options: { gatewayToken?: string } = {},
): void => {
  const log = deps.logger ?? (() => {});
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host}`);

    // Match /agents/:agentId/ws
    const match = url.pathname.match(/^\/agents\/([^/]+)\/ws$/);
    if (!match) {
      // Not our route — ignore (let other upgrade handlers or destroy).
      socket.destroy();
      return;
    }

    const agentId = decodeURIComponent(match[1]!);

    // Validate gateway token.
    if (options.gatewayToken) {
      const token = url.searchParams.get('token');
      if (token !== options.gatewayToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    const entry = deps.registry.get(agentId);
    if (!entry || entry.status !== 'running' || !entry.port) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const agentToken = await deps.lifecycle.getAgentToken(agentId);
    if (!agentToken) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    // Accept the client WebSocket.
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      // Connect to the agent's WS endpoint.
      const agentWsUrl = `ws://localhost:${entry.port}/ws?token=${encodeURIComponent(agentToken)}`;
      const agentWs = new WebSocket(agentWsUrl);

      agentWs.on('open', () => {
        log(`[ws-proxy] connected to agent ${agentId}`);
      });

      // Bidirectional proxy.
      clientWs.on('message', (data) => {
        if (agentWs.readyState === WebSocket.OPEN) {
          agentWs.send(data);
        }
      });

      agentWs.on('message', (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data);
        }
      });

      // Close propagation.
      clientWs.on('close', () => {
        agentWs.close();
      });

      agentWs.on('close', () => {
        clientWs.close();
      });

      // Error handling.
      clientWs.on('error', () => {
        agentWs.close();
      });

      agentWs.on('error', () => {
        clientWs.close();
      });
    });
  });
};
