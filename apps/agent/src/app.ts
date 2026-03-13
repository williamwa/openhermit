import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

import {
  agentLocalRoutes,
  isSessionCheckpointRequest,
  isSessionMessage,
  isSessionSpec,
  type SessionListQuery,
  isToolApprovalRequest,
} from '@openhermit/protocol';
import {
  OpenHermitError,
  UnauthorizedError,
  ValidationError,
  getErrorMessage,
  jsonError,
} from '@openhermit/shared';

import {
  InMemoryAgentRuntime,
  type SessionRuntime,
  type SessionEventEnvelope,
} from './runtime.js';
import type { AgentRunner } from './agent-runner.js';

const SSE_PING_INTERVAL_MS = 15_000;

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
  if (value === undefined) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new ValidationError(`Invalid boolean query value: ${value}`);
};

const parsePositiveIntegerQuery = (
  value: string | undefined,
  fieldName: string,
): number | undefined => {
  if (value === undefined) {
    return undefined;
  }

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

  if (kind) {
    query.kind = kind;
  }

  if (platform) {
    query.platform = platform;
  }

  if (url.searchParams.has('interactive')) {
    const interactive = parseBooleanQuery(
      url.searchParams.get('interactive') ?? undefined,
    );

    if (interactive !== undefined) {
      query.interactive = interactive;
    }
  }

  if (url.searchParams.has('limit')) {
    const limit = parsePositiveIntegerQuery(
      url.searchParams.get('limit') ?? undefined,
      'limit',
    );

    if (limit !== undefined) {
      query.limit = limit;
    }
  }

  return query;
};

export const createAgentApp = (
  runtime: SessionRuntime | AgentRunner = new InMemoryAgentRuntime(),
  options: { apiToken?: string; logger?: (message: string) => void } = {},
): Hono => {
  const app = new Hono();
  const log = options.logger ?? ((message: string) => console.log(message));

  app.use('*', async (c, next) => {
    const startedAt = Date.now();

    try {
      await next();
      log(
        `[openhermit-agent] ${c.req.method} ${c.req.path} -> ${c.res.status} ${Date.now() - startedAt}ms`,
      );
    } catch (error) {
      const status = error instanceof OpenHermitError ? error.statusCode : 500;
      log(
        `[openhermit-agent] ${c.req.method} ${c.req.path} -> ${status} ${Date.now() - startedAt}ms`,
      );
      throw error;
    }
  });

  app.use('*', async (c, next) => {
    if (c.req.path === agentLocalRoutes.health) {
      await next();
      return;
    }

    if (!options.apiToken) {
      await next();
      return;
    }

    const authorization = c.req.header('authorization');

    if (authorization !== `Bearer ${options.apiToken}`) {
      throw new UnauthorizedError('Invalid or missing bearer token.');
    }

    await next();
  });

  app.get(agentLocalRoutes.health, (c) =>
    c.json({
      ok: true,
      transport: 'http+sse',
    }),
  );

  app.post(agentLocalRoutes.sessions, async (c) => {
    const payload = await c.req.json().catch(() => null);

    if (!isSessionSpec(payload)) {
      throw new ValidationError('Invalid SessionSpec payload.');
    }

    const session = await runtime.openSession(payload);
    return c.json({ sessionId: session.spec.sessionId });
  });

  app.get(agentLocalRoutes.sessions, async (c) => {
    const query = parseSessionListQuery(c.req.raw);
    const sessions = await runtime.listSessions(query);
    return c.json(sessions);
  });

  app.post(agentLocalRoutes.sessionMessagesPattern, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const payload = await c.req.json().catch(() => null);

    if (!isSessionMessage(payload)) {
      throw new ValidationError('Invalid SessionMessage payload.');
    }

    const result = await runtime.postMessage(sessionId, payload);
    return c.json(result);
  });

  app.get(agentLocalRoutes.sessionMessagesPattern, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const messages = await runtime.listSessionMessages(sessionId);
    return c.json(messages);
  });

  app.post(agentLocalRoutes.sessionApprovePattern, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const payload = await c.req.json().catch(() => null);

    if (!isToolApprovalRequest(payload)) {
      throw new ValidationError('Invalid ToolApprovalRequest payload.');
    }

    // Only AgentRunner (not the stub InMemoryAgentRuntime) exposes respondToApproval.
    if (!('respondToApproval' in runtime)) {
      throw new ValidationError('This runtime does not support tool approvals.');
    }

    const resolved = (runtime as AgentRunner).respondToApproval(
      sessionId,
      payload.toolCallId,
      payload.approved,
    );

    return c.json({ resolved });
  });

  app.post(agentLocalRoutes.sessionCheckpointPattern, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
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

  app.get(agentLocalRoutes.sessionEventsPattern, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';

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

  app.onError((error, c) => {
    if (error instanceof OpenHermitError) {
      const openHermitError = error as OpenHermitError;
      return c.json(jsonError(openHermitError), openHermitError.statusCode);
    }

    console.error('[openhermit-agent] unhandled error', error);
    return c.json(jsonError(getErrorMessage(error), 'internal_error'), 500);
  });

  return app;
};
