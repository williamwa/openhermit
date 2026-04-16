import type { Context } from 'hono';
import { stream } from 'hono/streaming';

import type { AgentRegistry } from './agent-registry.js';
import type { AgentLifecycle } from './agent-lifecycle.js';

export interface ProxyDeps {
  registry: AgentRegistry;
  lifecycle: AgentLifecycle;
}

const buildUpstreamUrl = (
  port: number,
  strippedPath: string,
  queryString: string,
): string => {
  const qs = queryString ? `?${queryString}` : '';
  return `http://localhost:${port}${strippedPath}${qs}`;
};

/**
 * Proxy an incoming gateway request to the target agent process.
 *
 * Strips the `/agents/:agentId` prefix so the agent sees its normal
 * local routes (`/sessions/...`, `/health`, etc.).
 *
 * For SSE (Accept: text/event-stream), the response body is streamed
 * through to the client as-is.
 */
export const proxyToAgent = async (
  c: Context,
  deps: ProxyDeps,
): Promise<Response> => {
  const agentId = c.req.param('agentId') ?? '';
  const entry = deps.registry.get(agentId);

  if (!entry) {
    return c.json(
      { error: { code: 'not_found', message: `Agent not registered: ${agentId}` } },
      404,
    );
  }

  if (entry.status !== 'running' || !entry.port) {
    return c.json(
      {
        error: {
          code: 'agent_unavailable',
          message: `Agent ${agentId} is not running (status: ${entry.status})`,
        },
      },
      503,
    );
  }

  const token = await deps.lifecycle.getAgentToken(agentId);

  if (!token) {
    return c.json(
      { error: { code: 'agent_unavailable', message: `Cannot resolve token for agent ${agentId}` } },
      503,
    );
  }

  // Strip /agents/:agentId prefix to get the agent-local path.
  const fullPath = c.req.path;
  const prefix = `/agents/${encodeURIComponent(agentId)}`;
  const strippedPath = fullPath.slice(prefix.length) || '/';
  const queryString = new URL(c.req.url).search.slice(1);

  const upstreamUrl = buildUpstreamUrl(entry.port, strippedPath, queryString);
  const isSSE = c.req.header('accept')?.includes('text/event-stream');

  const upstreamHeaders: Record<string, string> = {
    authorization: `Bearer ${token}`,
  };

  const contentType = c.req.header('content-type');

  if (contentType) {
    upstreamHeaders['content-type'] = contentType;
  }

  if (isSSE) {
    upstreamHeaders['accept'] = 'text/event-stream';
  }

  const method = c.req.method;
  const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';

  let upstreamResponse: Response;

  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: upstreamHeaders,
      body: hasBody ? c.req.raw.body : undefined,
      // @ts-expect-error — Node fetch supports duplex for streaming request bodies
      duplex: hasBody ? 'half' : undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json(
      { error: { code: 'proxy_error', message: `Failed to reach agent ${agentId}: ${message}` } },
      502,
    );
  }

  // Stream through SSE responses (GET with Accept: text/event-stream,
  // or POST ?stream=true which returns Content-Type: text/event-stream).
  const isStreamingResponse =
    (isSSE && upstreamResponse.body) ||
    (upstreamResponse.body &&
      upstreamResponse.headers.get('content-type')?.includes('text/event-stream'));

  if (isStreamingResponse && upstreamResponse.body) {
    return stream(c, async (s) => {
      const reader = upstreamResponse.body!.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();

          if (done) {
            break;
          }

          await s.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }, async (_error, s) => {
      s.abort();
    });
  }

  // For regular JSON responses, forward status + body.
  const responseBody = await upstreamResponse.text();
  const responseContentType =
    upstreamResponse.headers.get('content-type') ?? 'application/json';

  return new Response(responseBody, {
    status: upstreamResponse.status,
    headers: { 'content-type': responseContentType },
  });
};
