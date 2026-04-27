import { promises as fs } from 'node:fs';
import path from 'node:path';
import { syncSkillMounts } from './skill-mounts.js';

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
import type {
  DbAgentStore,
  DbAgentConfigStore,
  DbMcpServerStore,
  DbScheduleStore,
  DbSkillStore,
  DbUserStore,
  DbAgentChannelStore,
} from '@openhermit/store';
import type { ChannelRegistry } from './auth.js';
import {
  ConflictError,
  NotFoundError,
  OpenHermitError,
  UnauthorizedError,
  ValidationError,
  getErrorMessage,
  jsonError,
  resolveAgentDataDir,
  resolveOpenHermitHome,
} from '@openhermit/shared';

import type { AgentRunner, SessionEventEnvelope } from '@openhermit/agent/agent-runner';
import { metricsRegistry, startDefaultMetrics } from '@openhermit/agent/metrics';
import { buildDefaultAgentConfig, listAllOpenHermitContainers } from '@openhermit/agent/core';
import { listProviderCatalog } from '@openhermit/agent/model-catalog';

import type { AgentInstanceManager } from './agent-instance.js';
import { listSessionsForCaller } from './session-listing.js';
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
  const channel = url.searchParams.get('channel');
  if (channel) query.channel = channel;

  // Collect metadata.* query params (e.g. ?metadata.telegram_chat_id=123)
  const metadata: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key.startsWith('metadata.')) {
      metadata[key.slice('metadata.'.length)] = value;
    }
  }
  if (Object.keys(metadata).length > 0) query.metadata = metadata;

  return query;
};

/** Require auth context or throw 401. Optionally enforce agent scoping. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const requireAuth = (c: any, agentId?: string): AuthContext => {
  const auth = c.get('auth' as never) as AuthContext | undefined;
  if (!auth) throw new UnauthorizedError('Authentication required.');

  // Enforce agent scoping: channel tokens and user JWTs are bound to a specific agent.
  if (agentId && auth.agentId && auth.agentId !== agentId) {
    throw new UnauthorizedError('Token is not valid for this agent.');
  }

  return auth;
};

/** Enforce that channel-authenticated requests only access sessions within their namespace. */
const enforceSessionNamespace = (auth: AuthContext, sessionId: string): void => {
  if (auth.mode === 'channel' && auth.channelNamespace) {
    const prefix = `${auth.channelNamespace}:`;
    if (!sessionId.startsWith(prefix)) {
      throw new ValidationError(
        `Channel "${auth.channelNamespace}" can only access sessions with prefix "${prefix}".`,
      );
    }
  }
};

// ─── App options ──────────────────────────────────────────────────────────────

export interface GatewayAppOptions {
  instances: AgentInstanceManager;
  agentStore?: DbAgentStore | undefined;
  skillStore?: DbSkillStore | undefined;
  scheduleStore?: DbScheduleStore | undefined;
  mcpServerStore?: DbMcpServerStore | undefined;
  userStore?: DbUserStore | undefined;
  configStore?: DbAgentConfigStore | undefined;
  agentChannelStore?: DbAgentChannelStore | undefined;
  /** Live ChannelRegistry — handlers mutate this when channels are created/revoked. */
  channelRegistry?: ChannelRegistry | undefined;
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
  const { instances, agentStore, adminToken, userStore, configStore } = options;
  const log = options.logger ?? ((msg: string) => console.log(msg));
  const app = new Hono();

  // Register default Node.js process metrics (heap, CPU, event loop) on
  // first app creation. The agent-runtime metrics are auto-registered when
  // their module is imported.
  startDefaultMetrics();

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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const requireOwnerOrAdmin = async (c: any, agentId: string): Promise<AuthContext> => {
    const auth = requireAuth(c, agentId);
    if (auth.mode === 'admin') return auth;
    const runtime = instances.getRunner(agentId);
    if (!runtime) throw new NotFoundError(`Agent ${agentId} is not running.`);
    const role = await runtime.resolveCallerRole({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (role !== 'owner') throw new UnauthorizedError('Owner role required.');
    return auth;
  };

  // --- JWT/channel auth middleware for agent routes ---

  if (options.auth) {
    const authOptions = options.auth;

    // Auth token exchange — before the general auth middleware
    app.post('/api/agents/:agentId/auth/token', async (c) => {
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

      // Ensure a user record exists for this channel identity. Auto-creates
      // a guest on first contact so we always have a stable userId to return
      // to the caller, instead of waiting for the first session-open.
      const ensure = instance.ensureUserForCaller
        ? await instance.ensureUserForCaller(
            { channel: authResult.channel, channelUserId: authResult.channelUserId },
            authResult.displayName,
          )
        : null;
      const userId = ensure?.userId;
      const isNewDevice = ensure?.created ?? false;

      if (!ensure?.created && authResult.displayName && instance.updateUserName) {
        await instance.updateUserName(
          { channel: authResult.channel, channelUserId: authResult.channelUserId },
          authResult.displayName,
        );
      }

      const { token, expiresAt } = await signJwt(authOptions.jwt, {
        agentId,
        channel: authResult.channel,
        channelUserId: authResult.channelUserId,
      });

      const role = ensure?.role
        ?? await instance.resolveCallerRole({
          channel: authResult.channel,
          channelUserId: authResult.channelUserId,
        });

      return c.json({
        token,
        expiresAt,
        isNewDevice,
        ...(userId ? { userId } : {}),
        ...(authResult.displayName ? { displayName: authResult.displayName } : {}),
        ...(role ? { role } : {}),
      });
    });

    // General auth middleware for all agent routes (except auth/token)
    const agentAuthMiddleware = async (c: any, next: any) => {
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
    };
    app.use('/api/agents/*', agentAuthMiddleware);
    // Global (non-agent-scoped) /api/* endpoints reuse the same auth
    // resolver so they accept either an admin token or any valid user
    // JWT. Endpoints that need agent-scoping enforce it themselves.
    app.use('/api/providers', agentAuthMiddleware);
  } else if (adminToken) {
    // No JWT auth configured, but admin token exists — resolve admin auth for per-agent management routes
    const adminMiddleware = async (c: any, next: any) => {
      const authorization = c.req.header('authorization');
      if (authorization?.startsWith('Bearer ') && authorization.slice(7) === adminToken) {
        c.set('auth' as never, { mode: 'admin', channel: 'admin', channelUserId: 'admin' } as never);
      }
      await next();
    };
    app.use('/api/agents/*', adminMiddleware);
    app.use('/api/providers', adminMiddleware);
  }

  // --- gateway health ---

  app.get('/health', (c) =>
    c.json({ ok: true, role: 'gateway' }),
  );

  // --- prometheus metrics (no auth — bind to localhost or scrape via reverse proxy) ---

  app.get('/metrics', async (c) => {
    const body = await metricsRegistry.metrics();
    return c.text(body, 200, { 'content-type': metricsRegistry.contentType });
  });

  // Static catalog of providers + models supported by the agent runtime
  // (sourced from @mariozechner/pi-ai). Global, not per-agent — the
  // catalog is identical for every agent. Any authenticated caller
  // (admin token or user JWT) can read it.
  app.get('/api/providers', (c) => {
    requireAuth(c);
    return c.json(listProviderCatalog());
  });

  // --- agent CRUD (admin-only) ---

  app.get(gatewayRoutes.agents, async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (agentStore) {
      const records = await agentStore.list();
      const agents = records.map((record) => ({
        agentId: record.agentId,
        status: instances.getRunner(record.agentId) ? 'running' as const : 'stopped' as const,
        ...(record.name ? { name: record.name } : {}),
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

    const homeDir = resolveOpenHermitHome();
    const now = new Date().toISOString();
    const record = await agentStore.create({
      agentId: body.agentId,
      ...(body.name ? { name: body.name } : {}),
      workspaceDir: body.workspaceDir ?? `${homeDir}/workspaces/${body.agentId}`,
      createdAt: now,
      updatedAt: now,
    });

    // Canonical agent config + security policy live in the DB.
    if (!configStore) {
      throw new OpenHermitError(
        'Agent config store is not configured (missing DATABASE_URL?).',
        'not_configured',
        500,
      );
    }
    // Make sure the per-agent local data dir (skill-mounts) exists.
    // Path is derived from OPENHERMIT_HOME + agentId.
    await fs.mkdir(resolveAgentDataDir(record.agentId), { recursive: true });

    const templateConfig = buildDefaultAgentConfig(record.workspaceDir);
    const templateSecurity = {
      autonomy_level: 'full',
      require_approval_for: [],
    };

    await configStore.setConfig(record.agentId, templateConfig as unknown as Record<string, unknown>);
    await configStore.setSecurity(record.agentId, templateSecurity);

    // Seed default instructions
    const agentName = record.name ?? record.agentId;
    await agentStore.seedInstructions(record.agentId, [
      {
        key: 'identity',
        content: [
          `You are ${agentName}, an AI assistant.`,
          '',
          'Describe who this agent is, its purpose, and its persona.',
        ].join('\n'),
      },
      {
        key: 'soul',
        content: [
          'You are helpful, thoughtful, and concise.',
          'You think step by step when solving complex problems.',
          '',
          'Define the agent\'s personality, tone, and communication style.',
        ].join('\n'),
      },
      {
        key: 'rules',
        content: [
          'Follow the user\'s instructions carefully.',
          'Ask for clarification when the request is ambiguous.',
          'Do not make up information.',
          '',
          'Add any rules or constraints the agent should follow.',
        ].join('\n'),
      },
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
        await instances.start(agentId, record.workspaceDir);
        return c.json({ agentId, status: 'running' });
      }

      case 'stop': {
        await instances.stop(agentId);
        return c.json({ agentId, status: 'stopped' });
      }

      case 'restart': {
        await instances.stop(agentId);
        await instances.start(agentId, record.workspaceDir);
        return c.json({ agentId, status: 'running' });
      }

      case 'delete': {
        if (instances.getRunner(agentId)) {
          throw new ValidationError(`Agent ${agentId} is still running. Stop it first.`);
        }
        await agentStore.delete(agentId);
        log(`agent deleted: ${agentId}`);
        return c.json({ agentId, status: 'deleted' });
      }

      default:
        throw new ValidationError(
          `Unknown lifecycle action: ${action}. Valid actions: start, stop, restart, delete`,
        );
    }
  });

  // --- sessions ---

  app.post(gatewayRoutes.agentSessionsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = requireAuth(c, agentId);
    const runtime = resolveRunner(instances, agentId);
    const payload = await c.req.json().catch(() => null);

    if (!isSessionSpec(payload)) {
      throw new ValidationError('Invalid SessionSpec payload.');
    }

    // Channel tokens can only create sessions within their namespace.
    enforceSessionNamespace(auth, payload.sessionId);

    // Pass caller identity directly to the runtime instead of injecting
    // it into session metadata — keeps "who's calling now" cleanly
    // separated from the session's persisted attributes.
    const caller = auth.mode === 'user' && auth.channelUserId
      ? { channel: auth.channel, channelUserId: auth.channelUserId }
      : undefined;
    const session = await runtime.openSession(payload, caller);
    return c.json({ sessionId: session.spec.sessionId });
  });

  app.get(gatewayRoutes.agentSessionsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = requireAuth(c, agentId);
    const runtime = resolveRunner(instances, agentId);
    const query = parseSessionListQuery(c.req.raw);
    return c.json(await listSessionsForCaller(runtime, auth, query));
  });

  // --- messages ---

  app.post(gatewayRoutes.agentSessionMessagesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
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
    const appendMode = url.searchParams.get('append') === 'true' || url.searchParams.get('inject') === 'true';

    if (appendMode) {
      await runtime.appendMessage(sessionId, payload);
      return c.json({ sessionId, appended: true });
    }

    const waitMode = url.searchParams.get('wait') === 'true';
    const streamMode = url.searchParams.get('stream') === 'true';

    // For fire-and-forget or when the server decides not to trigger (guest + not mentioned in group),
    // we can handle it early in wait/stream modes too.
    if (!waitMode && !streamMode) {
      const result = await runtime.postMessage(sessionId, payload);
      return c.json(result);
    }

    // Check if the message will actually trigger a response before setting up SSE/wait.
    // We need to post first, then check `triggered`.
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

      if (!result.triggered) {
        cleanup();
        return c.json({ sessionId, ...(messageId ? { messageId } : {}), text: null, toolCalls: [], triggered: false } satisfies SyncResponse & { triggered: boolean });
      }

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

      if (!result.triggered) {
        unsubscribe();
        return c.json(result);
      }

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
  });

  app.get(gatewayRoutes.agentSessionMessagesPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    const runtime = resolveRunner(instances, agentId);

    if (auth.mode === 'admin') {
      return c.json(await runtime.listSessionMessages(sessionId));
    }

    const callerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    if (!callerUserId) throw new NotFoundError(`Session not found: ${sessionId}`);
    const messages = await runtime.listSessionMessages(sessionId, callerUserId);
    return c.json(messages);
  });

  // --- approve ---

  app.post(gatewayRoutes.agentSessionApprovePattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const approveAuth = requireAuth(c, agentId);
    enforceSessionNamespace(approveAuth, sessionId);
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
    const cpAuth = requireAuth(c, agentId);
    enforceSessionNamespace(cpAuth, sessionId);
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

  // --- delete session ---

  app.delete('/api/agents/:agentId/sessions/:sessionId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
    const runtime = resolveRunner(instances, agentId);
    const callerUserId = await runtime.resolveCallerUserId({ channel: auth.channel, channelUserId: auth.channelUserId });
    await runtime.deleteSession(sessionId, callerUserId ?? undefined);
    return c.json({ deleted: true });
  });

  // --- SSE events ---

  app.get(gatewayRoutes.agentSessionEventsPattern, async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const sessionId = c.req.param('sessionId') ?? '';
    const auth = requireAuth(c, agentId);
    enforceSessionNamespace(auth, sessionId);
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

  // --- admin API ---

  app.get('/api/admin/agents/fleet', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!agentStore) return c.json([]);

    const records = await agentStore.list();
    const agentIds = records.map((r) => r.agentId);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const stats = await agentStore.fleetStats(agentIds, since);

    const fleet = await Promise.all(records.map(async (record) => {
      const stat = stats.get(record.agentId) ?? {
        sessions24h: 0, errors24h: 0, skillsCount: 0, mcpCount: 0,
      };
      const runner = instances.getRunner(record.agentId);
      const channelStatuses = instances.getChannelStatuses(record.agentId);
      const channelsEnabled = channelStatuses
        .filter((s) => s.status === 'connected')
        .map((s) => s.name);
      return {
        agentId: record.agentId,
        ...(record.name ? { name: record.name } : {}),
        status: runner ? 'running' as const : 'stopped' as const,
        sessions24h: stat.sessions24h,
        errors24h: stat.errors24h,
        ...(stat.lastActivity ? { lastActivity: stat.lastActivity } : {}),
        channels: channelsEnabled,
        skillsCount: stat.skillsCount,
        mcpCount: stat.mcpCount,
      };
    }));
    return c.json(fleet);
  });

  app.get('/api/admin/containers', async (c) => {
    requireAdmin(c.req.header('authorization'));
    try {
      const containers = await listAllOpenHermitContainers();
      // Resolve agent display name where possible.
      const nameByAgent = new Map<string, string | undefined>();
      if (agentStore) {
        const records = await agentStore.list();
        for (const r of records) nameByAgent.set(r.agentId, r.name);
      }
      return c.json(containers.map((ct) => ({
        ...ct,
        ...(nameByAgent.has(ct.agentId)
          ? { agentName: nameByAgent.get(ct.agentId) }
          : {}),
      })));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'docker_unavailable', message } }, 503);
    }
  });

  app.get('/api/admin/users', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!userStore) return c.json([]);
    const list = await userStore.list();
    const enriched = await Promise.all(list.map(async (u) => {
      const [identities, agents] = await Promise.all([
        userStore.listIdentities(u.userId),
        userStore.listAgentRoles(u.userId),
      ]);
      return {
        userId: u.userId,
        name: u.name ?? null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        identityCount: identities.length,
        agentCount: agents.length,
      };
    }));
    return c.json(enriched);
  });

  app.get('/api/admin/users/:userId/identities', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!userStore) return c.json([]);
    const identities = await userStore.listIdentities(c.req.param('userId'));
    return c.json(identities);
  });

  app.get('/api/admin/users/:userId/agents', async (c) => {
    requireAdmin(c.req.header('authorization'));
    if (!userStore) return c.json([]);
    const records = await userStore.listAgentRoles(c.req.param('userId'));
    return c.json(records);
  });

  app.get('/api/admin/stats', async (c) => {
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

  app.get('/api/admin/logs', (c) => {
    requireAdmin(c.req.header('authorization'));
    const lines = parsePositiveIntegerQuery(
      c.req.query('lines') ?? undefined,
      'lines',
    ) ?? 200;
    const entries = options.logBuffer?.tail(lines) ?? [];
    return c.json(entries);
  });

  app.get('/api/agents/:agentId/info', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    requireAuth(c, agentId);
    const record = await agentStore?.get(agentId);
    return c.json({
      agentId,
      name: record?.name ?? agentId,
      status: instances.getRunner(agentId) ? 'running' : 'stopped',
    });
  });

  // Returns ownership info for the agent: who the owner is (if any),
  // and — when ?channel=cli&channelUserId=alice is supplied — the user
  // record for that identity. Used by the CLI to decide whether to prompt
  // for ownership claim on connection.
  app.get('/api/agents/:agentId/ownership', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    requireAuth(c, agentId);
    if (!userStore) {
      throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
    }
    const agentUsers = await userStore.listByAgent({ agentId });
    const ownerEntry = agentUsers.find((u) => u.role === 'owner');
    let owner: { userId: string; name: string | null } | null = null;
    if (ownerEntry) {
      const ownerRecord = await userStore.get(ownerEntry.userId);
      owner = { userId: ownerEntry.userId, name: ownerRecord?.name ?? null };
    }

    const channel = c.req.query('channel');
    const channelUserId = c.req.query('channelUserId');
    let me: { userId: string; role: string | null; name: string | null } | null = null;
    if (channel && channelUserId) {
      const userId = await userStore.resolve(channel, channelUserId);
      if (userId) {
        const record = await userStore.get(userId);
        const roleEntry = agentUsers.find((u) => u.userId === userId);
        me = {
          userId,
          role: roleEntry?.role ?? null,
          name: record?.name ?? null,
        };
      }
    }
    return c.json({ hasOwner: !!owner, owner, me });
  });

  // Promote a user to owner of this agent. Idempotent if the user is
  // already the owner; rejects with 409 if a different user is the owner.
  // Admin-token only — the CLI uses this after asking the user to confirm.
  app.post('/api/agents/:agentId/users/:userId/promote-to-owner', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const userId = c.req.param('userId') ?? '';
    requireAdmin(c.req.header('authorization'));
    if (!userStore) {
      throw new OpenHermitError('User store is not configured.', 'not_configured', 500);
    }
    const scope = { agentId };
    const agentUsers = await userStore.listByAgent(scope);
    const existingOwner = agentUsers.find((u) => u.role === 'owner');
    if (existingOwner && existingOwner.userId !== userId) {
      const ownerRecord = await userStore.get(existingOwner.userId);
      throw new ConflictError(
        `Agent ${agentId} already has an owner: ${ownerRecord?.name ?? existingOwner.userId}.`,
      );
    }
    const target = await userStore.get(userId);
    if (!target) throw new NotFoundError(`User ${userId} not found.`);
    const now = new Date().toISOString();
    await userStore.assignAgent(scope, userId, 'owner', now);
    return c.json({ ok: true, userId, role: 'owner' });
  });

  app.get('/api/agents/:agentId/config', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (runner) {
      return c.json(await runner.security.readRawConfig());
    }
    // Stopped agent — read directly from the config store so admin UI can
    // inspect/edit before the agent has ever been started.
    if (!configStore) {
      throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
    }
    const config = await configStore.getConfig(agentId);
    if (!config) throw new NotFoundError(`Agent ${agentId} not found.`);
    return c.json(config);
  });

  app.put('/api/agents/:agentId/config', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const body = await c.req.json();
    const runner = instances.getRunner(agentId);
    if (runner) {
      await runner.security.writeConfig(body);
      return c.json({ ok: true });
    }
    if (!configStore) {
      throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
    }
    await configStore.setConfig(agentId, body);
    return c.json({ ok: true });
  });

  // Mask secret values: show first 4 + last 4 (with **** in between) for
  // long values, full mask for short ones. Empty string stays empty.
  const maskSecret = (value: string): string => {
    if (!value) return '';
    if (value.length <= 8) return '*'.repeat(value.length);
    return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-4)}`;
  };

  // Admin/owner endpoints below operate directly on the underlying stores
  // — they don't need a live runner. When a runner happens to be running,
  // we tell its security adapter to reload so its in-memory cache stays
  // consistent with what we just wrote.
  const reloadRunnerSecurity = async (agentId: string): Promise<void> => {
    const runner = instances.getRunner(agentId);
    if (runner) await runner.security.load();
  };

  app.get('/api/agents/:agentId/secrets', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    const all = await secretStore.list(agentId);
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(all)) masked[k] = maskSecret(v);
    return c.json(masked);
  });

  app.put('/api/agents/:agentId/secrets', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const body = await c.req.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ValidationError('Secrets must be a JSON object of string key-value pairs.');
    }
    for (const [k, v] of Object.entries(body)) {
      if (typeof v !== 'string') {
        throw new ValidationError(`Secret value for "${k}" must be a string.`);
      }
    }
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    await secretStore.setAll(agentId, body as Record<string, string>);
    await reloadRunnerSecurity(agentId);
    return c.json({ ok: true });
  });

  app.put('/api/agents/:agentId/secrets/:name', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const name = c.req.param('name') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    if (!name) throw new ValidationError('Secret name required.');
    const body = await c.req.json() as Record<string, unknown>;
    const value = body.value;
    if (typeof value !== 'string') {
      throw new ValidationError('Body must be { value: string }.');
    }
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    await secretStore.set(agentId, name, value);
    await reloadRunnerSecurity(agentId);
    return c.json({ ok: true });
  });

  app.delete('/api/agents/:agentId/secrets/:name', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const name = c.req.param('name') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    if (!name) throw new ValidationError('Secret name required.');
    const secretStore = instances.getSecretStore();
    if (!secretStore) {
      throw new OpenHermitError('Secret store is not configured.', 'not_configured', 500);
    }
    await secretStore.delete(agentId, name);
    await reloadRunnerSecurity(agentId);
    return c.json({ ok: true });
  });

  // --- admin: skills management ---

  const requireSkillStore = (): DbSkillStore => {
    if (!options.skillStore) {
      throw new OpenHermitError('Skill store is not configured.', 'not_configured', 500);
    }
    return options.skillStore;
  };

  app.get('/api/admin/skills', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const skills = await store.list();
    return c.json(skills);
  });

  app.get('/api/admin/skills/scan', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const { scanSkillDirectory } = await import('@openhermit/agent/skills');
    const homeDir = resolveOpenHermitHome();
    const skillsDir = `${homeDir}/skills`;
    const found = await scanSkillDirectory(skillsDir, skillsDir, 'system');
    return c.json(found);
  });

  app.get('/api/admin/skills/assignments', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const assignments = await store.listAssignments();
    return c.json(assignments);
  });

  app.get('/api/admin/skills/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const skill = await store.get(c.req.param('id'));
    if (!skill) throw new NotFoundError(`Skill not found: ${c.req.param('id')}`);
    return c.json(skill);
  });

  app.post('/api/admin/skills', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.id || typeof body.id !== 'string') throw new ValidationError('id is required');
    if (!body.name || typeof body.name !== 'string') throw new ValidationError('name is required');
    if (!body.description || typeof body.description !== 'string') throw new ValidationError('description is required');
    if (!body.path || typeof body.path !== 'string') throw new ValidationError('path is required');
    const now = new Date().toISOString();
    await store.upsert({
      id: body.id,
      name: body.name,
      description: body.description,
      path: body.path,
      ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata as Record<string, unknown> } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/admin/skills/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    await store.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  const syncAffectedAgentSkillMounts = async (agentId: string, store: DbSkillStore): Promise<void> => {
    const ids = agentId === '*' ? instances.getRunningAgentIds() : [agentId];
    for (const id of ids) {
      const runner = instances.getRunner(id);
      if (runner) {
        await syncSkillMounts(id, runner.security.getSkillMountsDir(), store);
      }
    }
  };

  app.post('/api/admin/skills/:id/enable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.enable(agentId, c.req.param('id'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  app.post('/api/admin/skills/:id/disable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireSkillStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.disable(agentId, c.req.param('id'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  // --- agent-level: effective skills list ---

  app.get('/api/agents/:agentId/skills', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const store = requireSkillStore();
    const runner = instances.getRunner(agentId);

    // Workspace path comes from the runner when up, otherwise from the
    // agent record. loadSkillIndex merges DB-enabled skills with what's
    // scanned from the workspace skill mounts.
    let workspaceRoot: string | undefined;
    if (runner) {
      workspaceRoot = runner.workspace.root;
    } else if (options.agentStore) {
      const record = await options.agentStore.get(agentId);
      workspaceRoot = record?.workspaceDir;
    }

    if (workspaceRoot) {
      const { loadSkillIndex } = await import('@openhermit/agent/skills');
      const skills = await loadSkillIndex(agentId, workspaceRoot, store);
      return c.json(skills);
    }

    // No workspace info available — return DB-enabled skills only.
    const dbSkills = await store.listEnabled(agentId);
    return c.json(dbSkills.map((s) => ({
      id: s.id, name: s.name, description: s.description,
      path: `/skills/${s.id}`, source: 'system' as const,
    })));
  });

  app.get('/api/agents/:agentId/mcp-servers', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    // Pure DB read — no runner needed. Lets admin inspect a stopped agent.
    const store = requireMcpServerStore();
    const servers = await store.listEnabled(agentId);
    return c.json(servers);
  });

  // --- agent-level: owner management endpoints ---

  app.post('/api/agents/:agentId/skills/:skillId/enable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireSkillStore();
    await store.enable(agentId, c.req.param('skillId'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/skills/:skillId/disable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireSkillStore();
    await store.disable(agentId, c.req.param('skillId'));
    await syncAffectedAgentSkillMounts(agentId, store);
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/mcp-servers/:serverId/enable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireMcpServerStore();
    await store.enable(agentId, c.req.param('serverId'));
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/mcp-servers/:serverId/disable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireMcpServerStore();
    await store.disable(agentId, c.req.param('serverId'));
    return c.json({ ok: true });
  });

  // ── Channels management ─────────────────────────────────────────────

  const CHANNEL_DEFS: Record<string, { label: string; secretKeys: { key: string; label: string; placeholder: string }[] }> = {
    telegram: {
      label: 'Telegram',
      secretKeys: [
        { key: 'TELEGRAM_BOT_TOKEN', label: 'Bot Token', placeholder: 'Enter Telegram bot token' },
      ],
    },
    discord: {
      label: 'Discord',
      secretKeys: [
        { key: 'DISCORD_BOT_TOKEN', label: 'Bot Token', placeholder: 'Enter Discord bot token' },
      ],
    },
    slack: {
      label: 'Slack',
      secretKeys: [
        { key: 'SLACK_BOT_TOKEN', label: 'Bot Token (xoxb-...)', placeholder: 'Enter Slack bot token' },
        { key: 'SLACK_APP_TOKEN', label: 'App Token (xapp-...)', placeholder: 'Enter Slack app token' },
      ],
    },
  };

  app.get('/api/agents/:agentId/channels', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);

    let rawConfig: Record<string, unknown>;
    let secretNames: string[];
    if (runner) {
      rawConfig = (await runner.security.readRawConfig()) as unknown as Record<string, unknown>;
      secretNames = await runner.security.listSecretNames();
    } else {
      // Stopped agent — fall back to the stores. Channel enable/disable still
      // requires a running agent (runtime side-effects), but listing is fine.
      if (!configStore) throw new NotFoundError(`Agent ${agentId} is not running and no config store is available.`);
      const stored = await configStore.getConfig(agentId);
      if (!stored) throw new NotFoundError(`Agent ${agentId} not found.`);
      rawConfig = stored;
      secretNames = []; // Without a runner we can't read the secret store; secretsSet will read as false.
    }
    const channels = (rawConfig.channels ?? {}) as Record<string, { enabled?: boolean }>;
    const runtimeStatuses = instances.getChannelStatuses(agentId);

    const result = Object.entries(CHANNEL_DEFS).map(([id, def]) => {
      const cfg = channels[id];
      const configured = !!cfg;
      const enabled = cfg?.enabled ?? false;
      const secretsSet = def.secretKeys.every((sk) => secretNames.includes(sk.key));
      const runtime = runtimeStatuses.find((s) => s.name === id);
      const status = !configured ? undefined : !enabled ? 'disabled' : runtime?.status ?? 'unknown';
      const error = runtime?.status === 'error' ? runtime.error : undefined;
      return { id, label: def.label, configured, enabled, secretsSet, secretKeys: def.secretKeys, status, error };
    });

    return c.json(result);
  });

  app.post('/api/agents/:agentId/channels/:channelId/enable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (!runner) throw new NotFoundError(`Agent ${agentId} is not running.`);
    if (!CHANNEL_DEFS[channelId]) throw new NotFoundError(`Unknown channel: ${channelId}`);

    const config = await runner.security.readRawConfig();
    const channels = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
    if (!channels[channelId]) throw new NotFoundError(`Channel ${channelId} is not configured. Configure it first.`);
    channels[channelId]!.enabled = true;
    await runner.security.writeConfig({ ...config, channels });

    const status = await instances.startSingleChannel(agentId, channelId, log);
    return c.json({ ok: true, status: status.status, error: status.error });
  });

  app.post('/api/agents/:agentId/channels/:channelId/disable', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (!runner) throw new NotFoundError(`Agent ${agentId} is not running.`);
    if (!CHANNEL_DEFS[channelId]) throw new NotFoundError(`Unknown channel: ${channelId}`);

    const config = await runner.security.readRawConfig();
    const channels = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
    if (!channels[channelId]) throw new NotFoundError(`Channel ${channelId} is not configured.`);
    channels[channelId]!.enabled = false;
    await runner.security.writeConfig({ ...config, channels });

    await instances.stopSingleChannel(agentId, channelId, log);
    return c.json({ ok: true });
  });

  app.put('/api/agents/:agentId/channels/:channelId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (!runner) throw new NotFoundError(`Agent ${agentId} is not running.`);
    const def = CHANNEL_DEFS[channelId];
    if (!def) throw new NotFoundError(`Unknown channel: ${channelId}`);

    const body = await c.req.json() as { secrets: Record<string, string> };
    if (!body.secrets || typeof body.secrets !== 'object') {
      return c.json({ error: { message: 'Missing secrets object' } }, 400);
    }

    // Write secrets
    const existingSecrets = await runner.security.readSecrets();
    for (const sk of def.secretKeys) {
      const val = body.secrets[sk.key];
      if (val && typeof val === 'string' && val.trim()) {
        existingSecrets[sk.key] = val.trim();
      }
    }
    await runner.security.writeSecrets(existingSecrets);

    // Write channel config with ${{SECRET}} placeholders
    const config = await runner.security.readRawConfig();
    const channels = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
    const channelCfg: Record<string, unknown> = { enabled: channels[channelId]?.enabled ?? true };

    if (channelId === 'telegram') {
      channelCfg.bot_token = '${{TELEGRAM_BOT_TOKEN}}';
      channelCfg.mode = 'polling';
    } else if (channelId === 'discord') {
      channelCfg.bot_token = '${{DISCORD_BOT_TOKEN}}';
    } else if (channelId === 'slack') {
      channelCfg.bot_token = '${{SLACK_BOT_TOKEN}}';
      channelCfg.app_token = '${{SLACK_APP_TOKEN}}';
    }

    channels[channelId] = channelCfg;
    await runner.security.writeConfig({ ...config, channels });
    return c.json({ ok: true });
  });

  app.delete('/api/agents/:agentId/channels/:channelId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const runner = instances.getRunner(agentId);
    if (!runner) throw new NotFoundError(`Agent ${agentId} is not running.`);

    const config = await runner.security.readRawConfig();
    const channels = (config.channels ?? {}) as Record<string, Record<string, unknown>>;
    delete channels[channelId];
    await runner.security.writeConfig({ ...config, channels });
    return c.json({ ok: true });
  });

  // ── External channel tokens ───────────────────────────────────────────
  // These are owner-issued tokens for channel adapters that run OUTSIDE the
  // gateway process (a Telegram bot deployed on another machine, etc.).
  // Built-in channels register their own ephemeral in-memory tokens at
  // agent boot — they don't go through this API.

  const requireAgentChannelStore = (): DbAgentChannelStore => {
    if (!options.agentChannelStore) {
      throw new OpenHermitError(
        'External channel store unavailable (DATABASE_URL or OPENHERMIT_SECRETS_KEY missing).',
        'not_configured',
        500,
      );
    }
    return options.agentChannelStore;
  };

  app.get('/api/agents/:agentId/external-channels', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const rows = await store.listForAgent(agentId);
    return c.json(rows);
  });

  app.post('/api/agents/:agentId/external-channels', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const auth = await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const body = await c.req.json().catch(() => ({})) as { namespace?: string; label?: string };
    if (!body.namespace || typeof body.namespace !== 'string') {
      throw new ValidationError('namespace is required (e.g. "telegram", "my-bot").');
    }
    // Resolve the creator — admin auth has no resolved user, so leave it null.
    let createdBy: string | undefined;
    if (auth.mode === 'user' && options.userStore) {
      const userId = await options.userStore.resolve(auth.channel, auth.channelUserId);
      if (userId) createdBy = userId;
    }
    const created = await store.create({
      agentId,
      namespace: body.namespace,
      ...(body.label ? { label: body.label } : {}),
      ...(createdBy ? { createdBy } : {}),
    });
    // Plug the new token into the live registry so it's usable immediately.
    options.channelRegistry?.register({
      channelId: created.id,
      apiKey: created.token,
      namespace: created.namespace,
      agentId,
    });
    // Plaintext token is returned ONCE — caller has to save it now.
    return c.json(created, 201);
  });

  app.delete('/api/agents/:agentId/external-channels/:channelId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    const channelId = c.req.param('channelId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireAgentChannelStore();
    const existing = await store.get(channelId);
    if (!existing || existing.agentId !== agentId) {
      throw new NotFoundError(`External channel ${channelId} not found on agent ${agentId}.`);
    }
    await store.revoke(channelId);
    options.channelRegistry?.unregister(channelId);
    return c.json({ ok: true });
  });

  app.get('/api/agents/:agentId/schedules', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const status = c.req.query('status') ?? undefined;
    const schedules = await store.list({ agentId }, status ? { status } : undefined);
    return c.json(schedules);
  });

  app.post('/api/agents/:agentId/schedules', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.type || (body.type !== 'cron' && body.type !== 'once')) {
      throw new ValidationError('type must be "cron" or "once"');
    }
    if (!body.prompt || typeof body.prompt !== 'string') {
      throw new ValidationError('prompt is required');
    }
    if (body.type === 'cron' && (!body.cronExpression || typeof body.cronExpression !== 'string')) {
      throw new ValidationError('cronExpression is required for cron schedules');
    }
    if (body.type === 'once' && (!body.runAt || typeof body.runAt !== 'string')) {
      throw new ValidationError('runAt is required for once schedules');
    }
    const schedule = await store.create({ agentId }, {
      ...(typeof body.id === 'string' ? { scheduleId: body.id } : {}),
      type: body.type as 'cron' | 'once',
      ...(typeof body.cronExpression === 'string' ? { cronExpression: body.cronExpression } : {}),
      ...(typeof body.runAt === 'string' ? { runAt: body.runAt } : {}),
      prompt: body.prompt,
      ...(body.delivery ? { delivery: body.delivery as any } : {}),
      ...(body.policy ? { policy: body.policy as any } : {}),
      createdBy: 'owner',
    });
    const runner = instances.getRunner(agentId);
    if (runner) await runner.reloadScheduler();
    return c.json(schedule, 201);
  });

  app.put('/api/agents/:agentId/schedules/:scheduleId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    const body = await c.req.json() as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (typeof body.status === 'string') patch.status = body.status;
    if (typeof body.prompt === 'string') patch.prompt = body.prompt;
    if (typeof body.cronExpression === 'string') patch.cronExpression = body.cronExpression;
    if (typeof body.runAt === 'string') patch.runAt = body.runAt;
    if (body.delivery !== undefined) patch.delivery = body.delivery;
    const updated = await store.update({ agentId }, scheduleId, patch as any);
    const runner = instances.getRunner(agentId);
    if (runner) await runner.reloadScheduler();
    return c.json(updated);
  });

  app.delete('/api/agents/:agentId/schedules/:scheduleId', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    await store.delete({ agentId }, scheduleId);
    const runner = instances.getRunner(agentId);
    if (runner) await runner.reloadScheduler();
    return c.json({ ok: true });
  });

  app.post('/api/agents/:agentId/schedules/:scheduleId/trigger', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    await store.update({ agentId }, scheduleId, { status: 'active' } as any);
    const runner = instances.getRunner(agentId);
    if (runner) await runner.reloadScheduler();
    return c.json({ ok: true, triggered: scheduleId });
  });

  app.get('/api/agents/:agentId/schedules/:scheduleId/runs', async (c) => {
    const agentId = c.req.param('agentId') ?? '';
    await requireOwnerOrAdmin(c, agentId);
    const store = requireScheduleStore();
    const scheduleId = c.req.param('scheduleId');
    const existing = await store.get({ agentId }, scheduleId);
    if (!existing) throw new NotFoundError(`Schedule not found: ${scheduleId}`);
    const limit = Number(c.req.query('limit')) || 20;
    const runs = await store.listRuns({ agentId }, scheduleId, limit);
    return c.json(runs);
  });

  // --- admin: MCP servers management ---

  const requireMcpServerStore = (): DbMcpServerStore => {
    if (!options.mcpServerStore) {
      throw new OpenHermitError('MCP server store is not configured.', 'not_configured', 500);
    }
    return options.mcpServerStore;
  };

  app.get('/api/admin/mcp-servers', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    return c.json(await store.list());
  });

  app.get('/api/admin/mcp-servers/assignments', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    return c.json(await store.listAssignments());
  });

  app.get('/api/admin/mcp-servers/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const server = await store.get(c.req.param('id'));
    if (!server) throw new NotFoundError(`MCP server not found: ${c.req.param('id')}`);
    return c.json(server);
  });

  app.post('/api/admin/mcp-servers', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const body = await c.req.json() as Record<string, unknown>;
    if (!body.id || typeof body.id !== 'string') throw new ValidationError('id is required');
    if (!body.name || typeof body.name !== 'string') throw new ValidationError('name is required');
    if (!body.description || typeof body.description !== 'string') throw new ValidationError('description is required');
    if (!body.url || typeof body.url !== 'string') throw new ValidationError('url is required');
    const now = new Date().toISOString();
    await store.upsert({
      id: body.id,
      name: body.name,
      description: body.description,
      url: body.url,
      ...(body.headers && typeof body.headers === 'object' ? { headers: body.headers as Record<string, string> } : {}),
      ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata as Record<string, unknown> } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ ok: true }, 201);
  });

  app.delete('/api/admin/mcp-servers/:id', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    await store.delete(c.req.param('id'));
    return c.json({ ok: true });
  });

  const syncAffectedAgentMcp = async (agentId: string): Promise<void> => {
    const ids = agentId === '*' ? instances.getRunningAgentIds() : [agentId];
    for (const id of ids) {
      const runner = instances.getRunner(id);
      if (runner) {
        await runner.reloadMcpServers();
      }
    }
  };

  app.post('/api/admin/mcp-servers/:id/enable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.enable(agentId, c.req.param('id'));
    await syncAffectedAgentMcp(agentId);
    return c.json({ ok: true });
  });

  app.post('/api/admin/mcp-servers/:id/disable', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireMcpServerStore();
    const body = await c.req.json() as Record<string, unknown>;
    const agentId = typeof body.agentId === 'string' ? body.agentId : '*';
    await store.disable(agentId, c.req.param('id'));
    await syncAffectedAgentMcp(agentId);
    return c.json({ ok: true });
  });

  // --- admin: schedule management ---

  const requireScheduleStore = (): DbScheduleStore => {
    if (!options.scheduleStore) {
      throw new OpenHermitError('Schedule store is not configured.', 'not_configured', 500);
    }
    return options.scheduleStore;
  };

  // List all schedules across all agents
  app.get('/api/admin/schedules', async (c) => {
    requireAdmin(c.req.header('authorization'));
    const store = requireScheduleStore();
    const status = c.req.query('status') ?? undefined;
    const all = await store.listAll(status ? { status } : undefined);
    return c.json(all);
  });

  // Per-agent schedule management is at /api/agents/:agentId/schedules (owner or admin auth)

  // --- admin UI: static files ---

  if (options.publicDir) {
    app.get('/admin', (c) => c.redirect('/admin/'));
    app.use('/admin/*', serveStatic({
      root: options.publicDir,
      rewriteRequestPath: (p) => p.replace(/^\/admin/, ''),
    }));
    // SPA fallback: serve index.html for unmatched /admin/* paths
    app.get('/admin/*', serveStatic({
      root: options.publicDir,
      rewriteRequestPath: () => '/index.html',
    }));
  }

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
