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
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
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

    const serveFile = async (filePath: string, cacheControl: string) => {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('not a file');
      const contentType = mimeTypes[path.extname(filePath)] ?? 'application/octet-stream';
      res.writeHead(200, {
        'content-type': contentType,
        'content-length': stat.size,
        'cache-control': cacheControl,
      });
      createReadStream(filePath).pipe(res);
    };

    try {
      await serveFile(resolved, pathname === '/index.html' ? 'no-cache' : 'public, max-age=60');
    } catch {
      // SPA fallback: serve index.html for paths without file extensions
      if (!path.extname(pathname)) {
        const indexPath = path.resolve(publicRoot, 'index.html');
        try {
          await serveFile(indexPath, 'no-cache');
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('Not found');
        }
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('Not found');
      }
    }
  });
