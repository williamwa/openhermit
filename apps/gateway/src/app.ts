import { Hono } from 'hono';

import { gatewayRoutes } from '@openhermit/protocol';
import type { CreateAgentRequest } from '@openhermit/protocol';
import type { DbAgentStore } from '@openhermit/store';
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
  agentStore?: DbAgentStore;
  logger?: (message: string) => void;
}

export const createGatewayApp = (options: GatewayAppOptions): Hono => {
  const { registry, lifecycle, agentStore } = options;
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

  app.get(gatewayRoutes.agents, async (c) => {
    if (agentStore) {
      const records = await agentStore.list();
      const agents = records.map((record) => {
        const entry = registry.get(record.agentId);
        return {
          agentId: record.agentId,
          status: entry?.status ?? ('registered' as const),
          ...(record.name ? { name: record.name } : {}),
          configDir: record.configDir,
          workspaceDir: record.workspaceDir,
          ...(entry?.port !== undefined ? { port: entry.port } : {}),
          ...(entry?.error ? { error: entry.error } : {}),
        };
      });
      return c.json(agents);
    }
    const agents = registry.list().map((entry) => registry.toAgentInfo(entry));
    return c.json(agents);
  });

  app.post(gatewayRoutes.agents, async (c) => {
    if (!agentStore) {
      return c.json(
        { error: { code: 'not_configured', message: 'Agent store is not configured. Set DATABASE_URL to enable agent persistence.' } },
        501,
      );
    }

    const body = await c.req.json<CreateAgentRequest>();

    if (!body.agentId || typeof body.agentId !== 'string') {
      throw new ValidationError('agentId is required and must be a string.');
    }

    const existing = await agentStore.get(body.agentId);
    if (existing) {
      return c.json(
        { error: { code: 'conflict', message: `Agent already exists: ${body.agentId}` } },
        409,
      );
    }

    const homeDir = process.env.OPENHERMIT_HOME ?? `${process.env.HOME ?? '/root'}/.openhermit`;
    const now = new Date().toISOString();
    const record = await agentStore.create({
      agentId: body.agentId,
      ...(body.name ? { name: body.name } : {}),
      configDir: body.configDir ?? `${homeDir}/${body.agentId}`,
      workspaceDir: body.workspaceDir ?? `${homeDir}/workspaces/${body.agentId}`,
      createdAt: now,
      updatedAt: now,
    });

    const agentName = record.name ?? record.agentId;
    await agentStore.seedInstructions(record.agentId, [
      { key: 'identity', content: `You are ${agentName}, an AI assistant.` },
      { key: 'soul', content: 'You are helpful, thoughtful, and concise. You think step by step when solving complex problems.' },
      { key: 'rules', content: 'Follow the user\'s instructions carefully. Ask for clarification when the request is ambiguous. Do not make up information.' },
    ], now);

    registry.register(record.agentId, {
      ...(record.name ? { name: record.name } : {}),
      configDir: record.configDir,
      workspaceDir: record.workspaceDir,
    });

    log(`agent created: ${record.agentId}`);

    const entry = registry.get(record.agentId)!;
    return c.json(registry.toAgentInfo(entry), 201);
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
