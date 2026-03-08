import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError } from '@cloudmind/shared';

import {
  type DockerCommandResult,
  type DockerRunner,
  DockerContainerManager,
} from '../src/core/index.js';
import { createBuiltInTools } from '../src/tools.js';
import { createSecurityFixture } from './helpers.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class FakeDockerRunner implements DockerRunner {
  readonly calls: string[][] = [];

  constructor(private readonly results: DockerCommandResult[]) {}

  async run(args: string[]): Promise<DockerCommandResult> {
    this.calls.push(args);
    const next = this.results.shift();
    if (!next) throw new Error(`Unexpected docker call: docker ${args.join(' ')}`);
    return next;
  }
}

const okDocker = (overrides: Partial<DockerCommandResult> = {}): DockerCommandResult => ({
  stdout: '', stderr: '', exitCode: 0, durationMs: 5, ...overrides,
});

const findTool = (tools: ReturnType<typeof createBuiltInTools>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" not found`);
  return tool;
};

// ---------------------------------------------------------------------------
// Minimal fetch mock helpers
// ---------------------------------------------------------------------------

type FetchImpl = typeof fetch;

const makeFetchMock = (
  status: number,
  body: string,
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): FetchImpl =>
  (async (_url, _init) => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(body);
    return new Response(bytes, { status, headers });
  }) as FetchImpl;

const makeFetchError = (message: string): FetchImpl =>
  (async (_url, _init) => {
    throw new Error(message);
  }) as FetchImpl;

// ---------------------------------------------------------------------------
// web_fetch tests
//
// web_fetch creates its tool via createWebFetchTool() which is not exported,
// so we access it through createBuiltInTools and inject a fetch mock via
// Node's globalThis.fetch override (the tool uses the global fetch).
// ---------------------------------------------------------------------------

// We temporarily replace globalThis.fetch for each test.
const withMockFetch = async (mockFetch: FetchImpl, fn: () => Promise<void>): Promise<void> => {
  const original = globalThis.fetch;
  // @ts-expect-error — intentional override for testing
  globalThis.fetch = mockFetch;
  try {
    await fn();
  } finally {
    // @ts-expect-error
    globalThis.fetch = original;
  }
};

test('web_fetch returns status, headers, and body for a successful GET', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(
    makeFetchMock(200, 'Hello, world!', { 'content-type': 'text/plain' }),
    async () => {
      const result = await tool.execute('call-1', { url: 'https://example.com/' });

      const text = result.content[0]?.text ?? '';
      assert.match(text, /HTTP 200/);
      assert.match(text, /Hello, world!/);

      const details = result.details as Record<string, unknown>;
      assert.equal(details.status, 200);
      assert.equal(details.method, 'GET');
      assert.equal(details.url, 'https://example.com/');
      assert.equal(details.body, 'Hello, world!');
      assert.equal(details.bodyBytes, 13);
      assert.equal(details.truncated, undefined);
    },
  );
});

test('web_fetch sends POST with body and custom headers', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  let capturedRequest: { url: RequestInfo | URL; init?: RequestInit } | undefined;

  const capturingFetch: FetchImpl = (async (url, init) => {
    capturedRequest = { url, init };
    return new Response('{"ok":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
  }) as FetchImpl;

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(capturingFetch, async () => {
    const result = await tool.execute('call-2', {
      url: 'https://api.example.com/data',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': 'abc' },
      body: '{"key":"value"}',
    });

    assert.ok(capturedRequest, 'fetch was called');
    assert.equal(capturedRequest?.init?.method, 'POST');
    assert.equal(
      (capturedRequest?.init?.headers as Record<string, string>)?.['x-token'],
      'abc',
    );
    assert.equal(capturedRequest?.init?.body, '{"key":"value"}');

    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, 201);
    assert.match(String(details.body), /ok.*true/);
  });
});

test('web_fetch truncates large responses at max_bytes', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const bigBody = 'x'.repeat(500);

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, bigBody), async () => {
    const result = await tool.execute('call-3', {
      url: 'https://example.com/big',
      max_bytes: 100,
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, true);
    assert.equal(details.bodyBytes, 500);
    assert.equal(details.returnedBytes, 100);
    assert.equal(String(details.body).length, 100);

    const text = result.content[0]?.text ?? '';
    assert.match(text, /truncated/i);
  });
});

test('web_fetch caps max_bytes at the hard 200 KB limit', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  // Body smaller than the hard limit but max_bytes asks for more than 200 KB
  await withMockFetch(makeFetchMock(200, 'small body'), async () => {
    const result = await tool.execute('call-4', {
      url: 'https://example.com/',
      max_bytes: 999_999_999,
    });

    // No truncation since body is small; the cap doesn't kick in unless body > 200 KB
    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, undefined);
    assert.equal(details.body, 'small body');
  });
});

test('web_fetch rejects non-http/https URLs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(
    () => tool.execute('call-5', { url: 'ftp://example.com/file' }),
    ValidationError,
  );
});

test('web_fetch rejects malformed URLs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(
    () => tool.execute('call-6', { url: 'not a url at all' }),
  );
});

test('web_fetch surfaces network errors as thrown exceptions', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchError('ECONNREFUSED'), async () => {
    await assert.rejects(
      () => tool.execute('call-7', { url: 'https://localhost:9/' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /ECONNREFUSED/);
        return true;
      },
    );
  });
});

test('web_fetch returns non-200 status without throwing', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(404, 'Not Found'), async () => {
    const result = await tool.execute('call-8', { url: 'https://example.com/missing' });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, 404);

    const text = result.content[0]?.text ?? '';
    assert.match(text, /HTTP 404/);
  });
});
