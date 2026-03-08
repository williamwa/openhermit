import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';

import {
  agentLocalRoutes,
  isSessionMessage,
  isSessionSpec,
  isToolApprovalRequest,
} from '@cloudmind/protocol';
import {
  CloudMindError,
  UnauthorizedError,
  ValidationError,
  getErrorMessage,
  jsonError,
} from '@cloudmind/shared';

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

export const createAgentApp = (
  runtime: SessionRuntime | AgentRunner = new InMemoryAgentRuntime(),
  options: { apiToken?: string } = {},
): Hono => {
  const app = new Hono();

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

  app.post(agentLocalRoutes.sessionMessagesPattern, async (c) => {
    const sessionId = c.req.param('sessionId') ?? '';
    const payload = await c.req.json().catch(() => null);

    if (!isSessionMessage(payload)) {
      throw new ValidationError('Invalid SessionMessage payload.');
    }

    const result = await runtime.postMessage(sessionId, payload);
    return c.json(result);
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

  app.get(agentLocalRoutes.events, async (c) => {
    const sessionId = c.req.query('sessionId');

    if (!sessionId) {
      throw new ValidationError('Missing sessionId query parameter.');
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

  app.onError((error, c) => {
    if (error instanceof CloudMindError) {
      return c.json(jsonError(error), error.statusCode);
    }

    console.error('[cloudmind-agent] unhandled error', error);
    return c.json(jsonError(getErrorMessage(error), 'internal_error'), 500);
  });

  return app;
};
