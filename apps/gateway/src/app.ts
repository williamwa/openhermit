import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';

import {
  gatewayRoutes,
  isSessionSpec,
  isSessionMessage,
  isToolApprovalRequest,
  isSessionCheckpointRequest,
  type CreateAgentRequest,
  type SessionListQuery,
  type SyncResponse,
  type SyncToolCall,
} from '@openhermit/protocol';
import type { DbAgentStore } from '@openhermit/store';
import {
  NotFoundError,
  OpenHermitError,
  UnauthorizedError,
  ValidationError,
  getErrorMessage,
  jsonError,
} from '@openhermit/shared';

import type { AgentRunner, SessionEventEnvelope } from '@openhermit/agent/agent-runner';

import type { AgentInstanceManager } from './agent-instance.js';
import type { LogBuffer } from './log-buffer.js';
import {
  type AuthContext,
  type AuthResolverOptions,
  type JwtConfig,
  type UserAuthProvider,
  resolveAuth,
  signJwt,
  verifyAdminToken,
} from './auth.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SSE_PING_INTERVAL_MS = 15_000;
const SYNC_DEFAULT_TIMEOUT_MS = 300_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const writeEvent = async (
  stream: SSEStreamingApi,
  envelope: SessionEventEnvelope,
): Promise<void> => {
  await stream.writeSSE({
    id: String(envelope.id),
    event: envelope.event.type,
    data: JSON.stringify(envelope.event),
  });
};

const waitForAbort = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
};

const parseBooleanQuery = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`Invalid boolean query value: ${value}`);
};

const parsePositiveIntegerQuery = (
  value: string | undefined,
  fieldName: string,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ValidationError(`Invalid ${fieldName} query value: ${value}`);
  }
  return parsed;
};

const parseSessionListQuery = (request: Request): SessionListQuery => {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const platform = url.searchParams.get('platform');
  const query: SessionListQuery = {};
  if (kind) query.kind = kind;
  if (platform) query.platform = platform;
  if (url.searchParams.has('interactive')) {
    const interactive = parseBooleanQuery(
      url.searchParams.get('interactive') ?? undefined,
    );
    if (interactive !== undefined) query.interactive = interactive;
  }
  if (url.searchParams.has('limit')) {
    const limit = parsePositiveIntegerQuery(
      url.searchParams.get('limit') ?? undefined,
      'limit',
    );
    if (limit !== undefined) query.limit = limit;
  }
  return query;
};

/** Require auth context or throw 401. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requireAuth = (c: any): AuthContext => {
  const auth = c.get('auth' as never) as AuthContext | undefined;
  if (!auth) throw new UnauthorizedError('Authentication required.');
  return auth;
};

// ─── App options ──────────────────────────────────────────────────────────────

export interface GatewayAppOptions {
  instances: AgentInstanceManager;
  agentStore?: DbAgentStore | undefined;
  auth?: AuthResolverOptions | undefined;
  adminToken?: string | undefined;
  logger?: ((message: string) => void) | undefined;
  logBuffer?: LogBuffer | undefined;
  /** Absolute path to the public directory for serving static UI files. */
  publicDir?: string | undefined;
  /** CORS allowed origin (default: '*'). */
  corsOrigin?: string | undefined;
}

// ─── Resolve runner helper ────────────────────────────────────────────────────

const resolveRunner = (
  instances: AgentInstanceManager,
  agentId: string,
): AgentRunner => {
  const runner = instances.getRunner(agentId);
  if (!runner) {
    throw new NotFoundError(`Agent ${agentId} is not running.`);
  }
  return runner;
};

// ─── App factory ──────────────────────────────────────────────────────────────

export const createGatewayApp = (options: GatewayAppOptions): Hono => {
  const { instances, agentStore, adminToken } = options;
  const log = options.logger ?? ((msg: string) => console.log(msg));
  const app = new Hono();

  // --- CORS ---

  app.use('*', cors({
    origin: options.corsOrigin ?? '*',
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Type'],
  }));

  // --- request logging ---

  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
      log(`${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - startedAt}ms`);
    } catch (error) {
      const status = error instanceof OpenHermitError ? error.statusCode : 500;
      log(`${c.req.method} ${c.req.path} -> ${status} ${Date.now() - startedAt}ms`);
      throw error;
    }
  });

  // --- admin auth middleware for management routes ---

  const requireAdmin = (authorization: string | undefined): void => {
    if (!adminToken) {
      throw new UnauthorizedError('Admin API is not configured. Set GATEWAY_ADMIN_TOKEN.');
    }
    if (!verifyAdminToken(adminToken, authorization)) {
      throw new UnauthorizedError('Invalid admin token.');
    }
  };

  // --- JWT/channel auth middleware for agent routes ---

  if (options.auth) {
    const authOptions = options.auth;

    // Auth token exchange — before the general auth middleware
    app.post('/agents/:agentId/auth/token', async (c) => {
      const agentId = c.req.param('agentId') ?? '';
      const instance = instances.getRunner(agentId);
      if (!instance) {
        throw new NotFoundError(`Agent ${agentId} is not running.`);
      }

      const body: Record<string, unknown> = await c.req.json().catch(() => ({}));

      // Check agent access policy
      const security = instance.security;
      const accessLevel = security.getAccessLevel();
      if (accessLevel === 'protected') {
        const agentAccessToken = body.agent_token;
        const expectedToken = security.getAccessToken();
        if (!expectedToken || agentAccessToken !== expectedToken) {
          throw new UnauthorizedError('Invalid or missing agent access token.');
        }
      }

      // Try each user auth provider
      let authResult: import('./auth.js').UserAuthResult | null = null;
      for (const provider of authOptions.userProviders) {
        authResult = await provider.authenticate(body);
        if (authResult) break;
      }

      if (!authResult) {
        throw new UnauthorizedError('Invalid credentials.');
      }

      const { token, expiresAt } = await signJwt(authOptions.jwt, {
        agentId,
        channel: authResult.channel,
        channelUserId: authResult.channelUserId,
      });

      return c.json({ token, expiresAt });
    });

    // General auth middleware for all agent routes (except auth/token)
    app.use('/agents/*', async (c, next) => {
      // Skip auth for the token exchange endpoint (already handled above)
      if (c.req.path.endsWith('/auth/token') && c.req.method === 'POST') {
        await next();
        return;
      }

      const authContext = await resolveAuth(c.req.raw, authOptions);
      if (authContext) {
        c.set('auth' as never, authContext as never);
      }
      await next();
    });
  }

  // --- gateway health ---

  app.get('/health', (c) =>
    c.json({ ok: true, role: 'gateway' }),
  );

  // --- agent CRUD (admin-only) ---

  app.get(gatewayRoutes.agents, async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (agentStore) {
      const records = await agentStore.list();
      const agents = records.map((record) => ({
        agentId: record.agentId,
        status: instances.getRunner(record.agentId) ? 'running' as const : 'stopped' as const,
        ...(record.name ? { name: record.name } : {}),
        configDir: record.configDir,
        workspaceDir: record.workspaceDir,
      }));
      return c.json(agents);
    }
    return c.json([]);
  });

  app.post(gatewayRoutes.agents, async (c) => {
    requireAdmin(c.req.header('authorization'));
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

    // Assign owner if specified
    if (body.ownerUserId && typeof body.ownerUserId === 'string') {
      await agentStore.assignOwner(record.agentId, body.ownerUserId, now);
      log(`agent created: ${record.agentId} (owner: ${body.ownerUserId})`);
    } else {
      log(`agent created: ${record.agentId}`);
    }

    return c.json({
      agentId: record.agentId,
      status: 'stopped' as const,
      ...(record.name ? { name: record.name } : {}),
      configDir: record.configDir,
      workspaceDir: record.workspaceDir,
    }, 201);
  });

  // --- agent health ---

  app.get(gatewayRoutes.agentHealthPattern, (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const runner = instances.getRunner(agentId);
    return c.json({
      agentId,
      ok: !!runner,
      status: runner ? 'running' : 'stopped',
    });
  });

  // --- lifecycle management (admin-only) ---

  app.post(gatewayRoutes.agentManagePattern, async (c) => {
    requireAdmin(c.req.header('authorization'));
    const agentId = c.req.param('agentId') ?? '';
    const action = c.req.param('action') ?? '';

    if (!agentStore) {
      throw new ValidationError('Agent store is not configured.');
    }

    const record = await agentStore.get(agentId);
    if (!record) {
      return c.json(
        { error: { code: 'not_found', message: `Agent not found: ${agentId}` } },
        404,
      );
    }

    switch (action) {
      case 'start': {
        if (instances.getRunner(agentId)) {
          throw new ValidationError(`Agent ${agentId} is already running.`);
        }
        await instances.start(agentId, record.configDir, record.workspaceDir);
        return c.json({ agentId, status: 'running' });
      }

      case 'stop': {
        await instances.stop(agentId);
        return c.json({ agentId, status: 'stopped' });
      }

      case 'restart': {
        await instances.stop(agentId);
        await instances.start(agentId, record.configDir, record.workspaceDir);
        return c.json({ agentId, status: 'running' });
      }

      default:
        throw new ValidationError(
          `Unknown lifecycle action: ${action}. Valid actions: start, stop, restart`,
        );
    }
  });

  // --- sessions ---

  app.post(gatewayRoutes.agentSessionsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);
    const payload = await c.req.json().catch(() => null);

    if (!isSessionSpec(payload)) {
      throw new ValidationError('Invalid SessionSpec payload.');
    }

    // Inject authenticated user identity into session metadata
    if (auth.mode === 'user' && auth.channelUserId) {
      payload.metadata = {
        ...payload.metadata,
        username: auth.channelUserId,
      };
    }

    const session = await runtime.openSession(payload);
    return c.json({ sessionId: session.spec.sessionId });
  });

  app.get(gatewayRoutes.agentSessionsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);
    const query = parseSessionListQuery(c.req.raw);
    const callerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (!callerUserId) return c.json([]);
    const sessions = await runtime.listSessions(query, callerUserId);
    return c.json(sessions);
  });

  // --- messages ---

  app.post(gatewayRoutes.agentSessionMessagesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);

    // Verify caller is a participant (user mode only; channels handle identity per-message)
    if (auth.mode === 'user') {
      const msgCallerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
      if (msgCallerUserId) {
        await runtime.verifySessionAccess(sessionId, msgCallerUserId);
      }
    }

    const payload = await c.req.json().catch(() => null);

    if (!isSessionMessage(payload)) {
      throw new ValidationError('Invalid SessionMessage payload.');
    }

    // Channel namespace enforcement
    if (auth.mode === 'channel' && auth.channelNamespace && payload.sender) {
      if (payload.sender.channel !== auth.channelNamespace) {
        throw new ValidationError(
          `Channel namespace violation: channel "${auth.channelNamespace}" cannot declare sender identity for "${payload.sender.channel}".`,
        );
      }
    }

    const url = new URL(c.req.url);
    const waitMode = url.searchParams.get('wait') === 'true';
    const streamMode = url.searchParams.get('stream') === 'true';

    if (waitMode) {
      const timeoutMs = parsePositiveIntegerQuery(
        url.searchParams.get('timeout') ?? undefined,
        'timeout',
      ) ?? SYNC_DEFAULT_TIMEOUT_MS;

      const toolCalls: SyncToolCall[] = [];
      let text: string | null = null;
      let error: string | undefined;
      let messageId: string | undefined;
      let done = false;
      let resolvePromise: ((response: Response) => void) | undefined;

      const timer = setTimeout(() => {
        cleanup();
        const response: SyncResponse = {
          sessionId,
          ...(messageId ? { messageId } : {}),
          text,
          toolCalls,
          error: 'Timeout waiting for agent response.',
        };
        resolvePromise?.(c.json(response, 504));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribe();
      };

      const unsubscribe = runtime.events.subscribe(sessionId, (envelope) => {
        const ev = envelope.event;
        switch (ev.type) {
          case 'tool_result':
            toolCalls.push({
              tool: ev.tool,
              isError: ev.isError,
              ...(ev.text !== undefined ? { text: ev.text } : {}),
              ...(ev.details !== undefined ? { details: ev.details } : {}),
            });
            break;
          case 'text_final':
            text = ev.text;
            break;
          case 'error':
            error = ev.message;
            break;
          case 'agent_end':
            done = true;
            cleanup();
            resolvePromise?.(c.json({
              sessionId,
              ...(messageId ? { messageId } : {}),
              text,
              toolCalls,
              ...(error !== undefined ? { error } : {}),
            } satisfies SyncResponse));
            break;
        }
      });

      const result = await runtime.postMessage(sessionId, payload);
      messageId = result.messageId;

      if (done) {
        cleanup();
        return c.json({
          sessionId,
          ...(messageId ? { messageId } : {}),
          text,
          toolCalls,
          ...(error !== undefined ? { error } : {}),
        } satisfies SyncResponse);
      }

      return new Promise<Response>((resolve) => {
        resolvePromise = resolve;
      });
    }

    if (streamMode) {
      const buffered: SessionEventEnvelope[] = [];
      let streamReady = false;
      let streamApi: SSEStreamingApi | undefined;

      const unsubscribe = runtime.events.subscribe(sessionId, async (envelope) => {
        if (streamReady && streamApi) {
          await writeEvent(streamApi, envelope);
          if (envelope.event.type === 'agent_end') {
            unsubscribe();
            void streamApi.close();
          }
        } else {
          buffered.push(envelope);
        }
      });

      const result = await runtime.postMessage(sessionId, payload);

      return streamSSE(c, async (stream) => {
        streamApi = stream;

        if (result.messageId) {
          await stream.writeSSE({
            event: 'message_ack',
            data: JSON.stringify({ sessionId, messageId: result.messageId }),
          });
        }

        let closed = false;
        for (const envelope of buffered) {
          await writeEvent(stream, envelope);
          if (envelope.event.type === 'agent_end') {
            unsubscribe();
            closed = true;
            break;
          }
        }
        buffered.length = 0;
        streamReady = true;

        if (!closed) {
          await waitForAbort(c.req.raw.signal);
          unsubscribe();
        }
      });
    }

    // Default: fire-and-forget.
    const result = await runtime.postMessage(sessionId, payload);
    return c.json(result);
  });

  app.get(gatewayRoutes.agentSessionMessagesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);
    const callerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (!callerUserId) throw new NotFoundError(`Session not found: ${sessionId}`);
    const messages = await runtime.listSessionMessages(sessionId, callerUserId);
    return c.json(messages);
  });

  // --- approve ---

  app.post(gatewayRoutes.agentSessionApprovePattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const approveAuth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);
    const approveCallerId = await runtime.resolveCallerUserId({ channel: approveAuth.channel, channelUserId: approveAuth.channelUserId });
    if (approveCallerId) {
      await runtime.verifySessionAccess(sessionId, approveCallerId);
    }
    const payload = await c.req.json().catch(() => null);

    if (!isToolApprovalRequest(payload)) {
      throw new ValidationError('Invalid ToolApprovalRequest payload.');
    }

    const resolved = runtime.respondToApproval(
      sessionId,
      payload.toolCallId,
      payload.approved,
    );

    return c.json({ resolved });
  });

  // --- checkpoint ---

  app.post(gatewayRoutes.agentSessionCheckpointPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const cpAuth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);
    const cpCallerId = await runtime.resolveCallerUserId({ channel: cpAuth.channel, channelUserId: cpAuth.channelUserId });
    if (cpCallerId) {
      await runtime.verifySessionAccess(sessionId, cpCallerId);
    }
    const payload = await c.req.json().catch(() => ({}));

    if (!isSessionCheckpointRequest(payload)) {
      throw new ValidationError('Invalid SessionCheckpointRequest payload.');
    }

    const checkpointed = await runtime.checkpointSession(
      sessionId,
      payload.reason ?? 'manual',
    );

    return c.json({ checkpointed });
  });

  // --- SSE events ---

  app.get(gatewayRoutes.agentSessionEventsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c);
    const runtime = resolveRunner(instances, agentId);
    // Verify caller is a participant
    const eventsCallerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (eventsCallerUserId) {
      await runtime.verifySessionAccess(sessionId, eventsCallerUserId);
    }

    return streamSSE(c, async (stream) => {
      for (const envelope of runtime.events.getBacklog(sessionId)) {
        await writeEvent(stream, envelope);
      }

      const unsubscribe = runtime.events.subscribe(sessionId, async (envelope) => {
        await writeEvent(stream, envelope);
      });

      const heartbeat = setInterval(() => {
        void stream.writeSSE({
          event: 'ping',
          data: JSON.stringify({ sessionId }),
        });
      }, SSE_PING_INTERVAL_MS);

      try {
        await stream.writeSSE({
          event: 'ready',
          data: JSON.stringify({ sessionId }),
        });
        await waitForAbort(c.req.raw.signal);
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  });

  // --- admin UI: static files ---

  if (options.publicDir) {
    app.get('/ui', (c) => c.redirect('/ui/'));
    app.use('/ui/*', serveStatic({
      root: options.publicDir,
      rewriteRequestPath: (p) => p.replace(/^\/ui/, ''),
    }));
  }

  // --- admin API ---

  app.get('/admin/stats', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const memoryUsage = process.memoryUsage();
    const counts = agentStore ? await agentStore.counts() : { users: 0, sessions: 0, sessionEvents: 0 };
    return c.json({
      uptime: process.uptime(),
      memory: {
        rss: memoryUsage.rss,
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
      },
      agents: {
        running: instances.listRunnerIds().length,
      },
      counts,
    });
  });

  app.get('/admin/logs', (c) => {
    requireAdmin(c.req.header('authorization'));
    const lines = parsePositiveIntegerQuery(
      c.req.query('lines') ?? undefined,
      'lines',
    ) ?? 200;
    const entries = options.logBuffer?.tail(lines) ?? [];
    return c.json(entries);
  });

  app.get('/admin/agents/:agentId/config', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const agentId = c.req.param('agentId') ?? '';
    const runner = instances.getRunner(agentId);
    if (!runner) {
      throw new NotFoundError(`Agent ${agentId} is not running. Start the agent to read its config.`);
    }
    const config = await runner.security.readConfig();
    return c.json(config);
  });

  app.put('/admin/agents/:agentId/config', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const agentId = c.req.param('agentId') ?? '';
    const runner = instances.getRunner(agentId);
    if (!runner) {
      throw new NotFoundError(`Agent ${agentId} is not running. Start the agent to update its config.`);
    }
    const body = await c.req.json();
    await runner.security.writeConfig(body);
    return c.json({ ok: true });
  });

  app.get('/admin/agents/:agentId/secrets', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const agentId = c.req.param('agentId') ?? '';
    const runner = instances.getRunner(agentId);
    if (!runner) {
      throw new NotFoundError(`Agent ${agentId} is not running.`);
    }
    await runner.security.load();
    return c.json(runner.security.readSecrets());
  });

  app.put('/admin/agents/:agentId/secrets', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const agentId = c.req.param('agentId') ?? '';
    const runner = instances.getRunner(agentId);
    if (!runner) {
      throw new NotFoundError(`Agent ${agentId} is not running.`);
    }
    const body = await c.req.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Secrets must be a JSON object of string key-value pairs.');
    }
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== 'string') {
        throw new ValidationError(`Secret value for "${k}" must be a string.`);
      }
    }
    await runner.security.writeSecrets(body as Record<string, string>);
    return c.json({ ok: true });
  });

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
