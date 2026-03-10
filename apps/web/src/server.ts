import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentLocalClient } from '@openhermit/sdk';
import { getErrorMessage, jsonError, OpenHermitError } from '@openhermit/shared';

import { readAgentRuntimeConnection } from './runtime.js';

export interface WebServerOptions {
  agentId: string;
  workspaceRoot: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicRoot = path.resolve(__dirname, '../public');

const mimeTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sendJson = (
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const sendText = (
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void => {
  res.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return null;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

const createAgentClient = async (workspaceRoot: string): Promise<{
  client: AgentLocalClient;
  token: string;
  baseUrl: string;
  port: string;
}> => {
  const runtime = await readAgentRuntimeConnection(workspaceRoot);

  return {
    client: new AgentLocalClient({
      baseUrl: runtime.baseUrl,
      token: runtime.token,
    }),
    token: runtime.token,
    baseUrl: runtime.baseUrl,
    port: runtime.port,
  };
};

const serveStaticFile = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
  const resolved = path.resolve(publicRoot, `.${pathname}`);

  if (!resolved.startsWith(publicRoot)) {
    sendText(res, 404, 'Not found');
    return true;
  }

  try {
    const stat = await fs.stat(resolved);

    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return true;
    }

    const contentType =
      mimeTypes[path.extname(resolved)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': stat.size,
      'cache-control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=60',
    });
    createReadStream(resolved).pipe(res);
    return true;
  } catch {
    return false;
  }
};

export const createWebServer = (options: WebServerOptions): http.Server =>
  http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const { pathname, searchParams } = requestUrl;

      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, transport: 'http+proxy+sse' });
        return;
      }

      if (pathname === '/api/bootstrap' && req.method === 'GET') {
        const runtime = await readAgentRuntimeConnection(options.workspaceRoot);
        sendJson(res, 200, {
          agentId: options.agentId,
          workspaceRoot: options.workspaceRoot,
          agentApiPort: runtime.port,
        });
        return;
      }

      if (pathname === '/api/sessions' && req.method === 'GET') {
        const { client } = await createAgentClient(options.workspaceRoot);
        const interactive = searchParams.get('interactive');
        const limit = searchParams.get('limit');
        const query: {
          kind?: string;
          platform?: string;
          interactive?: boolean;
          limit?: number;
        } = {};

        const kind = searchParams.get('kind');
        const platform = searchParams.get('platform');

        if (kind) {
          query.kind = kind;
        }

        if (platform) {
          query.platform = platform;
        }

        if (interactive !== null) {
          query.interactive = interactive === 'true';
        }

        if (limit !== null) {
          query.limit = Number.parseInt(limit, 10);
        }

        const sessions = await client.listSessions(query);
        sendJson(res, 200, sessions);
        return;
      }

      if (pathname === '/api/sessions' && req.method === 'POST') {
        const { client } = await createAgentClient(options.workspaceRoot);
        const payload = await readJsonBody(req);
        const response = await client.openSession(payload as never);
        sendJson(res, 200, response);
        return;
      }

      const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
      if (messageMatch && req.method === 'POST') {
        const { client } = await createAgentClient(options.workspaceRoot);
        const payload = await readJsonBody(req);
        const sessionId = decodeURIComponent(messageMatch[1] ?? '');
        const response = await client.postMessage(sessionId, payload as never);
        sendJson(res, 200, response);
        return;
      }

      const approveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/approve$/);
      if (approveMatch && req.method === 'POST') {
        const { client } = await createAgentClient(options.workspaceRoot);
        const payload = await readJsonBody(req);
        const sessionId = decodeURIComponent(approveMatch[1] ?? '');
        const response = await client.submitApproval(sessionId, payload as never);
        sendJson(res, 200, response);
        return;
      }

      const eventsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && req.method === 'GET') {
        const sessionId = decodeURIComponent(eventsMatch[1] ?? '');

        const runtime = await createAgentClient(options.workspaceRoot);
        const controller = new AbortController();
        const abortUpstream = (): void => {
          if (!controller.signal.aborted) {
            controller.abort();
          }
        };

        req.on('aborted', abortUpstream);
        res.on('close', abortUpstream);

        try {
          const upstream = await fetch(runtime.client.buildEventsUrl(sessionId), {
            headers: {
              authorization: `Bearer ${runtime.token}`,
            },
            signal: controller.signal,
          });

          if (!upstream.ok || !upstream.body) {
            sendText(
              res,
              upstream.status,
              await upstream.text(),
              upstream.headers.get('content-type') ?? 'text/plain; charset=utf-8',
            );
            return;
          }

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });

          const reader = upstream.body.getReader();

          try {
            while (true) {
              const { done, value } = await reader.read();

              if (done) {
                break;
              }

              if (value && !res.destroyed) {
                res.write(Buffer.from(value));
              }
            }
          } finally {
            if (!res.writableEnded) {
              res.end();
            }
          }
        } catch (error) {
          if (isAbortError(error)) {
            if (!res.writableEnded) {
              res.end();
            }
            return;
          }

          throw error;
        } finally {
          req.off('aborted', abortUpstream);
          res.off('close', abortUpstream);
        }

        return;
      }

      if (await serveStaticFile(req, res)) {
        return;
      }

      sendText(res, 404, 'Not found');
    } catch (error) {
      if (res.headersSent || res.writableEnded) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      if (error instanceof SyntaxError) {
        sendJson(res, 400, jsonError('Invalid JSON payload.', 'validation_error'));
        return;
      }

      if (error instanceof OpenHermitError) {
        sendJson(res, error.statusCode, jsonError(error));
        return;
      }

      console.error('[openhermit-web] request failed', error);
      sendJson(res, 500, jsonError(getErrorMessage(error), 'internal_error'));
    }
  });
