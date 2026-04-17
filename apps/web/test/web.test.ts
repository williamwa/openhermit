import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { createWebServer } from '../src/index.js';

const request = async (
  port: number,
  pathname: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body,
          headers: res.headers,
        });
      });
    });

    req.on('error', reject);
  });

test('createWebServer serves the index page from the public directory', async () => {
  const server = createWebServer({ port: 0 });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const response = await request(address.port, '/');

    assert.equal(response.status, 200);
    assert.match(String(response.headers['content-type']), /text\/html/);
    assert.match(response.body, /<!doctype html>/i);
    assert.match(response.body, /OpenHermit/i);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }
});

test('createWebServer blocks path traversal outside the public directory', async () => {
  const server = createWebServer({ port: 0 });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const response = await request(address.port, '/../package.json');

    assert.equal(response.status, 404);
    assert.equal(response.body, 'Not found');
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }
});
