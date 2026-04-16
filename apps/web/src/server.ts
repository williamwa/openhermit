import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export interface WebServerOptions {
  port: number;
}

export const createWebServer = (options: WebServerOptions): http.Server =>
  http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname;
    const resolved = path.resolve(publicRoot, `.${pathname}`);

    if (!resolved.startsWith(publicRoot)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }

    try {
      const stat = await fs.stat(resolved);

      if (!stat.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
        return;
      }

      const contentType =
        mimeTypes[path.extname(resolved)] ?? 'application/octet-stream';
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': stat.size,
        'cache-control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=60',
      });
      createReadStream(resolved).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    }
  });
