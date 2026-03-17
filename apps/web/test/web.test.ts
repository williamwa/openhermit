import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { internalStateFiles } from '@openhermit/shared';

import { createWebServer, parseWebCliArgs, resolveWorkspaceRoot } from '../src/index.js';

test('resolveWorkspaceRoot uses explicit workspace when provided', () => {
  assert.equal(
    resolveWorkspaceRoot('/repo', 'agent-a', './runtime/agent-a'),
    '/repo/runtime/agent-a',
  );
});

test('parseWebCliArgs resolves agent id, workspace, and port', () => {
  const parsed = parseWebCliArgs(
    ['--agent-id', 'agent-a', '--workspace', './runtime/agent-a', '--port', '4321'],
    '/repo',
    {},
  );

  assert.deepEqual(parsed, {
    agentId: 'agent-a',
    workspaceRoot: '/repo/runtime/agent-a',
    port: 4321,
  });
});

test('parseWebCliArgs uses defaults', () => {
  const parsed = parseWebCliArgs([], '/repo', {});

  assert.deepEqual(parsed, {
    agentId: 'main',
    workspaceRoot: '/repo/.openhermit-dev/main',
    port: 4310,
  });
});

test('parseWebCliArgs validates port values', () => {
  assert.throws(
    () => parseWebCliArgs(['--port', '0'], '/repo', {}),
    /Invalid port/,
  );
});

test('createWebServer tolerates SSE client disconnects without crashing', async () => {
  const originalFetch = globalThis.fetch;
  const originalOpenHermitHome = process.env.OPENHERMIT_HOME;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openhermit-web-test-'));
  const workspaceRoot = path.join(tempRoot, '.openhermit-dev', 'main');
  const openHermitHome = path.join(tempRoot, '.openhermit');
  const agentRoot = path.join(openHermitHome, 'main');
  const encoder = new TextEncoder();

  await fs.mkdir(agentRoot, { recursive: true });
  await fs.writeFile(
    path.join(agentRoot, internalStateFiles.runtime),
    `${JSON.stringify(
      {
        http_api: {
          port: 3999,
          token: 'test-token',
        },
        updated_at: '2026-03-13T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  globalThis.fetch = async (_input, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: ready\ndata: {"sessionId":"web:test"}\n\n'),
          );

          init?.signal?.addEventListener(
            'abort',
            () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
          );
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    );

  const server = createWebServer({
    agentId: 'main',
    workspaceRoot,
  });
  process.env.OPENHERMIT_HOME = openHermitHome;

  try {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (code === 'EPERM') {
        return;
      }

      throw error;
    }

    const address = server.address();
    assert.ok(address && typeof address === 'object');

    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${address.port}/api/sessions/web%3Atest/events`,
        (res) => {
          res.once('data', () => {
            req.destroy();
            setTimeout(resolve, 25);
          });
          res.resume();
        },
      );

      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET') {
          resolve();
          return;
        }

        reject(error);
      });
    });

    assert.equal(server.listening, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOpenHermitHome === undefined) {
      delete process.env.OPENHERMIT_HOME;
    } else {
      process.env.OPENHERMIT_HOME = originalOpenHermitHome;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });

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
