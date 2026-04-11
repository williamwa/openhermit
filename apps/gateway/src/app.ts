import { Hono } from 'hono';

import { gatewayRoutes } from '@openhermit/protocol';
import {
  OpenHermitError,
  ValidationError,
  getErrorMessage,
  jsonError,
} from '@openhermit/shared';

import type { AgentRegistry } from './agent-registry.js';
import type { AgentLifecycle } from './agent-lifecycle.js';
import { proxyToAgent } from './proxy.js';

export interface GatewayAppOptions {
  registry: AgentRegistry;
  lifecycle: AgentLifecycle;
  logger?: (message: string) => void;
}

export const createGatewayApp = (options: GatewayAppOptions): Hono => {
  const { registry, lifecycle } = options;
  const log = options.logger ?? ((msg: string) => console.log(msg));
  const app = new Hono();

  // --- request logging ---

  app.use('*', async (c, next) => {
    const startedAt = Date.now();

    try {
      await next();
      log(
        `[openhermit-gateway] ${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      const status = error instanceof OpenHermitError ? error.statusCode : 500;
      log(
        `[openhermit-gateway] ${c.req.method} ${c.req.path} -> ${status} ${Date.now() - startedAt}ms`,
      );
      throw error;
    }
  });

  // --- gateway health ---

  app.get('/health', (c) =>
    c.json({ ok: true, role: 'gateway' }),
  );

  // --- agent listing ---

  app.get(gatewayRoutes.agents, (c) => {
    const agents = registry.list().map((entry) => registry.toAgentInfo(entry));
    return c.json(agents);
  });

  // --- lifecycle management ---

  app.post(gatewayRoutes.agentManagePattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const action = c.req.param('action') ?? '';

    const entry = registry.get(agentId);

    if (!entry) {
      return c.json(
        { error: { code: 'not_found', message: `Agent not registered: ${agentId}` } },
        404,
      );
    }

    switch (action) {
      case 'start': {
        const updated = await lifecycle.start(agentId);
        return c.json(registry.toAgentInfo(updated));
      }

      case 'stop': {
        await lifecycle.stop(agentId);
        const stopped = registry.get(agentId)!;
        return c.json(registry.toAgentInfo(stopped));
      }

      case 'restart': {
        const restarted = await lifecycle.restart(agentId);
        return c.json(registry.toAgentInfo(restarted));
      }

      default:
        throw new ValidationError(
          `Unknown lifecycle action: ${action}. Valid actions: start, stop, restart`,
        );
    }
  });

  // --- agent health (proxied) ---

  app.get(gatewayRoutes.agentHealthPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const alive = await lifecycle.healthCheck(agentId);

    return c.json({
      agentId,
      ok: alive,
      status: registry.get(agentId)?.status ?? 'unknown',
    });
  });

  // --- proxy: sessions, messages, events, approve, checkpoint ---

  const proxyDeps = { registry, lifecycle };

  app.get(gatewayRoutes.agentSessionsPattern, (c) => proxyToAgent(c, proxyDeps));
  app.post(gatewayRoutes.agentSessionsPattern, (c) => proxyToAgent(c, proxyDeps));

  app.get(gatewayRoutes.agentSessionMessagesPattern, (c) => proxyToAgent(c, proxyDeps));
  app.post(gatewayRoutes.agentSessionMessagesPattern, (c) => proxyToAgent(c, proxyDeps));

  app.get(gatewayRoutes.agentSessionEventsPattern, (c) => proxyToAgent(c, proxyDeps));

  app.post(gatewayRoutes.agentSessionApprovePattern, (c) => proxyToAgent(c, proxyDeps));

  app.post(gatewayRoutes.agentSessionCheckpointPattern, (c) => proxyToAgent(c, proxyDeps));

  // --- error handler ---

  app.onError((error, c) => {
    if (error instanceof OpenHermitError) {
      return c.json(jsonError(error), error.statusCode);
    }

    console.error('[openhermit-gateway] unhandled error', error);
    return c.json(jsonError(getErrorMessage(error), 'internal_error'), 500);
  });

  return app;
};
