import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type DockerCommandResult,
  type DockerRunner,
  DockerContainerManager,
} from '../src/core/index.js';
import { SqliteInternalStateStore, standaloneScope } from '@openhermit/store';
import { createBuiltInTools, withApproval } from '../src/tools.js';
import { createSecurityFixture, createTempDir } from './helpers.js';

const getFirstText = (result: {
  content: Array<{ type: string; text?: string }>;
}): string => {
  const first = result.content.find((entry) => entry.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
};

class FakeDockerRunner implements DockerRunner {
  readonly calls: string[][] = [];

  constructor(private readonly results: DockerCommandResult[]) {}

  async run(args: string[]): Promise<DockerCommandResult> {
    this.calls.push(args);
    const next = this.results.shift();

    if (!next) {
      throw new Error(`Unexpected docker call: docker ${args.join(' ')}`);
    }

    return next;
  }
}

const okResult = (overrides: Partial<DockerCommandResult> = {}): DockerCommandResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  ...overrides,
});

const findTool = (tools: ReturnType<typeof createBuiltInTools>, name: string) => {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool, `Tool "${name}" not found in createBuiltInTools`);
  return tool;
};

const registerService = async (
  containerManager: DockerContainerManager,
  name: string,
  image: string,
): Promise<void> => {
  await containerManager.startService({
    name,
    image,
  });
};

type FetchImpl = typeof fetch;

const makeFetchMock = (
  status: number,
  body: string,
  headers: Record<string, string> = { 'content-type': 'text/plain' },
): FetchImpl =>
  (async (_url, _init) => {
    const encoder = new TextEncoder();
    return new Response(encoder.encode(body), { status, headers });
  }) as FetchImpl;

const makeFetchError = (message: string): FetchImpl =>
  (async (_url, _init) => {
    throw new Error(message);
  }) as FetchImpl;

const withMockFetch = async (mockFetch: FetchImpl, fn: () => Promise<void>): Promise<void> => {
  const globals = globalThis as typeof globalThis & { fetch: FetchImpl };
  const original = globals.fetch;
  globals.fetch = mockFetch;

  try {
    await fn();
  } finally {
    globals.fetch = original;
  }
};

test('withApproval forwards signal and onUpdate to the wrapped tool', async (t) => {
  const { security } = await createSecurityFixture(t, {
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['dangerous_tool'],
    },
  });
  await security.load();

  const Params = Type.Object({
    value: Type.String(),
  });

  let capturedSignal: AbortSignal | undefined;
  let capturedOnUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
  let approvalArgs: unknown;
  const requestedCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
  const startedCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];

  const tool: AgentTool<typeof Params, { status: string }> = {
    name: 'dangerous_tool',
    label: 'Dangerous Tool',
    description: 'Tool used to verify approval forwarding.',
    parameters: Params,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      capturedSignal = signal;
      capturedOnUpdate = onUpdate;
      onUpdate?.({
        content: [{ type: 'text', text: `updating ${args.value}` }],
        details: { status: 'midway' },
      });

      return {
        content: [{ type: 'text', text: `done ${args.value}` }],
        details: { status: 'done' },
      };
    },
  };

  const wrapped = withApproval(
    tool,
    security,
    async (_toolName, _toolCallId, args) => {
      approvalArgs = args;
      return 'approved';
    },
    async (toolName, toolCallId, args) => {
      requestedCalls.push({ toolName, toolCallId, args });
    },
    async (toolName, toolCallId, args) => {
      startedCalls.push({ toolName, toolCallId, args });
    },
  );

  const abortController = new AbortController();
  const updates: Array<{ status: string }> = [];

  const result = await wrapped.execute(
    'call-1',
    { value: 'payload' },
    abortController.signal,
    ((partial) => {
      updates.push(partial.details);
    }) as AgentToolUpdateCallback<{ status: string }>,
  );

  assert.equal(capturedSignal, abortController.signal);
  assert.ok(capturedOnUpdate);
  assert.deepEqual(approvalArgs, { value: 'payload' });
  assert.deepEqual(requestedCalls, [
    {
      toolName: 'dangerous_tool',
      toolCallId: 'call-1',
      args: { value: 'payload' },
    },
  ]);
  assert.deepEqual(startedCalls, [
    {
      toolName: 'dangerous_tool',
      toolCallId: 'call-1',
      args: { value: 'payload' },
    },
  ]);
  assert.deepEqual(updates, [{ status: 'midway' }]);
  assert.deepEqual(result.details, { status: 'done' });
});

test('withApproval distinguishes timeout from explicit rejection', async (t) => {
  const { security } = await createSecurityFixture(t, {
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['dangerous_tool'],
    },
  });
  await security.load();

  const Params = Type.Object({
    value: Type.String(),
  });

  const tool: AgentTool<typeof Params, { status: string }> = {
    name: 'dangerous_tool',
    label: 'Dangerous Tool',
    description: 'Tool used to verify approval decisions.',
    parameters: Params,
    execute: async () => {
      throw new Error('should not execute when approval is not granted');
    },
  };

  const requestedCalls: string[] = [];
  const startedCalls: string[] = [];

  const timedOut = withApproval(
    tool,
    security,
    async () => 'timed_out',
    async (toolName) => {
      requestedCalls.push(toolName);
    },
    async (toolName) => {
      startedCalls.push(toolName);
    },
  );
  const rejected = withApproval(
    tool,
    security,
    async () => 'rejected',
    async (toolName) => {
      requestedCalls.push(toolName);
    },
    async (toolName) => {
      startedCalls.push(toolName);
    },
  );

  const timedOutResult = await timedOut.execute('call-timeout', { value: 'payload' });
  const rejectedResult = await rejected.execute('call-rejected', { value: 'payload' });

  assert.match(getFirstText(timedOutResult), /timed out waiting for user approval/);
  assert.deepEqual(timedOutResult.details, {
    rejected: true,
    toolName: 'dangerous_tool',
    approvalStatus: 'timed_out',
  });

  assert.match(getFirstText(rejectedResult), /rejected by the user/);
  assert.deepEqual(rejectedResult.details, {
    rejected: true,
    toolName: 'dangerous_tool',
    approvalStatus: 'rejected',
  });
  assert.deepEqual(requestedCalls, ['dangerous_tool', 'dangerous_tool']);
  assert.deepEqual(startedCalls, []);
});

test('file_search finds literal matches across workspace files', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  await workspace.writeFile(
    'files/notes.txt',
    ['hello world', 'alpha hello beta', 'goodbye'].join('\n'),
  );
  await workspace.writeFile(
    'memory/notes/preferences.md',
    ['preferred language: TypeScript', 'say hello politely'].join('\n'),
  );

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'file_search');

  const result = await tool.execute('call-search-1', {
    pattern: 'hello',
  });

  const text = getFirstText(result);
  assert.match(text, /Found 3 matches in 2 file\(s\)/);
  assert.match(text, /files\/notes.txt:1:1 hello world/);
  assert.match(text, /memory\/notes\/preferences.md:2:5 say hello politely/);

  const details = result.details as Record<string, unknown>;
  assert.equal(details.pattern, 'hello');
  assert.equal(details.path, '.');
  assert.ok(Number(details.scannedFiles) >= 2);
  assert.equal(details.matchedFiles, 2);
  assert.equal(details.totalMatches, 3);
  assert.equal(details.returnedMatches, 3);
  assert.equal(details.truncated, false);
});

test('memory_update stores named memory, memory_recall finds it, and memory_get returns full content', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryStore = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    workspace,
    security,
    containerManager,
    memoryStore,
    storeScope: standaloneScope,
  });
  const updateTool = findTool(tools, 'memory_update');
  const getTool = findTool(tools, 'memory_get');
  const recallTool = findTool(tools, 'memory_recall');

  const updateResult = await updateTool.execute('call-memory-update', {
    key: 'main',
    title: 'Language preference',
    content: 'The user prefers TypeScript for new examples.',
    tags: ['preferences', 'language'],
  });

  const updateDetails = updateResult.details as Record<string, unknown>;
  assert.equal(updateDetails.memoryKey, 'main');

  const recallResult = await recallTool.execute('call-memory-recall', {
    query: 'TypeScript',
    limit: 3,
  });

  const recallText = getFirstText(recallResult);
  assert.match(recallText, /TypeScript/);
  assert.match(recallText, /Language preference/);

  const recallDetails = recallResult.details as Record<string, unknown>;
  assert.equal(recallDetails.query, 'TypeScript');
  assert.equal(recallDetails.count, 1);

  const getResult = await getTool.execute('call-memory-get', {
    key: 'main',
  });
  const getDetails = getResult.details as Record<string, unknown>;
  assert.equal(getDetails.memoryKey, 'main');
  assert.equal(
    getDetails.content,
    'The user prefers TypeScript for new examples.',
  );
  assert.equal(getDetails.title, 'Language preference');
});

test('memory_recall supports key_prefix filtering and memory_update can write now', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryStore = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    workspace,
    security,
    containerManager,
    memoryStore,
    storeScope: standaloneScope,
  });
  const updateTool = findTool(tools, 'memory_update');
  const recallTool = findTool(tools, 'memory_recall');

  await updateTool.execute('call-memory-update-now', {
    key: 'now',
    content: 'I am currently working in session:web:abc on the OpenHermit web UI.',
  });
  await updateTool.execute('call-memory-update-project', {
    key: 'project/openhermit/plan',
    content: 'Next up: scheduler and identity split.',
  });

  const recallResult = await recallTool.execute('call-memory-recall-prefix', {
    query: 'scheduler',
    key_prefix: 'project/openhermit/',
  });

  const recallDetails = recallResult.details as Record<string, unknown>;
  assert.equal(recallDetails.count, 1);
  assert.equal(
    (recallDetails.matches as Array<Record<string, unknown>>)[0]?.memoryKey,
    'project/openhermit/plan',
  );
});

test('memory_get rejects unknown keys', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryStore = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    workspace,
    security,
    containerManager,
    memoryStore,
    storeScope: standaloneScope,
  });
  const getTool = findTool(tools, 'memory_get');

  await assert.rejects(
    () =>
      getTool.execute('call-memory-get-missing', {
        key: 'project/missing',
      }),
    (error: unknown) =>
      error instanceof ValidationError
      && /Memory not found: project\/missing/.test(error.message),
  );
});

test('memory_update is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: {
      autonomy_level: 'readonly',
      require_approval_for: [],
    },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryStore = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    workspace,
    security,
    containerManager,
    memoryStore,
    storeScope: standaloneScope,
  });
  const updateTool = findTool(tools, 'memory_update');

  await assert.rejects(
    () =>
      updateTool.execute('call-memory-readonly', {
        content: 'Remember this forever.',
      }),
    ValidationError,
  );
});

test('file_search supports path scoping and glob filters', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  await workspace.writeFile('files/app.ts', 'const greeting = "hello";\n');
  await workspace.writeFile('files/app.md', 'hello from markdown\n');
  await workspace.writeFile('memory/notes/topic.md', 'hello from notes\n');

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'file_search');

  const result = await tool.execute('call-search-2', {
    pattern: 'hello',
    path: 'files',
    glob: 'files/**/*.md',
  });

  const text = getFirstText(result);
  assert.match(text, /Found 1 matches in 1 file\(s\)/);
  assert.match(text, /files\/app.md:1:1 hello from markdown/);
  assert.doesNotMatch(text, /app\.ts/);

  const details = result.details as Record<string, unknown>;
  assert.equal(details.path, 'files');
  assert.equal(details.glob, 'files/**/*.md');
  assert.equal(details.matchedFiles, 1);
  assert.equal(details.totalMatches, 1);
});

test('file_search rejects an empty pattern', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'file_search');

  await assert.rejects(
    () => tool.execute('call-search-3', { pattern: '' }),
    ValidationError,
  );
});

test('file_search rejects search paths that escape the workspace root', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'file_search');

  await assert.rejects(
    () =>
      tool.execute('call-search-escape', {
        pattern: 'hello',
        path: '../outside',
      }),
    ValidationError,
  );
});

test('file_search skips symlinked paths that point outside the workspace', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const outsideDir = await createTempDir(t, 'openhermit-search-outside-');
  const outsideFile = path.join(outsideDir, 'secret.txt');
  await fs.writeFile(outsideFile, 'outside secret needle\n', 'utf8');

  await workspace.writeFile('files/inside.txt', 'inside needle\n');
  await fs.symlink(outsideFile, path.join(workspace.root, 'files', 'outside-link.txt'));

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'file_search');

  const result = await tool.execute('call-search-symlink', {
    pattern: 'needle',
    path: 'files',
  });

  const text = getFirstText(result);
  assert.match(text, /files\/inside.txt:1:8 inside needle/);
  assert.doesNotMatch(text, /outside-link\.txt/);
  assert.doesNotMatch(text, /outside secret needle/);

  const details = result.details as Record<string, unknown>;
  assert.equal(details.scannedFiles, 1);
  assert.equal(details.matchedFiles, 1);
  assert.equal(details.totalMatches, 1);
});

test('file_search truncates large result sets and skips oversized files', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  await workspace.writeFile(
    'files/many.txt',
    Array.from({ length: 120 }, () => 'needle').join('\n'),
  );
  await workspace.writeFile(
    'files/too-large.txt',
    'x'.repeat(1_000_001),
  );

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'file_search');

  const result = await tool.execute('call-search-4', {
    pattern: 'needle',
    path: 'files',
  });

  const text = getFirstText(result);
  assert.match(text, /Results truncated to the first 100 matches/);
  assert.match(text, /Skipped 1 large file\(s\): files\/too-large.txt/);

  const details = result.details as Record<string, unknown>;
  assert.equal(details.totalMatches, 120);
  assert.equal(details.returnedMatches, 100);
  assert.equal(details.truncated, true);
  assert.deepEqual(details.skippedLargeFiles, ['files/too-large.txt']);
});

test('web_fetch returns status headers and body for a successful GET', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(
    makeFetchMock(200, 'Hello, world!', { 'content-type': 'text/plain' }),
    async () => {
      const result = await tool.execute('call-web-1', {
        url: 'https://example.com/',
        output: 'raw',
      });

      const text = getFirstText(result);
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

test('web_fetch is still wrapped by approval callbacks in createBuiltInTools', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['web_fetch'],
    },
  });
  await security.load();

  const approvalCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
  const requestedCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
  const startedCalls: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({
    workspace,
    security,
    containerManager,
    approvalCallback: async (toolName, toolCallId, args) => {
      approvalCalls.push({ toolName, toolCallId, args });
      return 'approved';
    },
    onToolRequested: async (toolName, toolCallId, args) => {
      requestedCalls.push({ toolName, toolCallId, args });
    },
    onToolStarted: async (toolName, toolCallId, args) => {
      startedCalls.push({ toolName, toolCallId, args });
    },
  });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, 'ok'), async () => {
    const result = await tool.execute('call-web-2', {
      url: 'https://example.com/approved',
      output: 'raw',
    });
    assert.match(getFirstText(result), /HTTP 200/);
  });

  const expectedCall = {
    toolName: 'web_fetch',
    toolCallId: 'call-web-2',
    args: { url: 'https://example.com/approved', output: 'raw' },
  };
  assert.deepEqual(approvalCalls, [expectedCall]);
  assert.deepEqual(requestedCalls, [expectedCall]);
  assert.deepEqual(startedCalls, [expectedCall]);
});

test('web_fetch truncates large responses at max_bytes', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const bigBody = 'x'.repeat(500);
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, bigBody), async () => {
    const result = await tool.execute('call-web-3', {
      url: 'https://example.com/big',
      max_bytes: 100,
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, true);
    assert.equal(details.bodyBytes, 500);
    assert.equal(details.returnedBytes, 100);
    assert.equal(String(details.body).length, 100);
    assert.match(getFirstText(result), /truncated/i);
  });
});

test('web_fetch caps max_bytes at the hard 200 KB limit', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, 'small body'), async () => {
    const result = await tool.execute('call-web-4', {
      url: 'https://example.com/',
      max_bytes: 999_999_999,
      output: 'raw',
    });

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

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(
    () =>
      tool.execute('call-web-5', {
        url: 'ftp://example.com/file',
        output: 'raw',
      }),
    ValidationError,
  );
});

test('web_fetch rejects malformed URLs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(() =>
    tool.execute('call-web-6', { url: 'not a url at all', output: 'raw' }),
  );
});

test('web_fetch rejects non-positive max_bytes', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await assert.rejects(
    () =>
      tool.execute('call-web-7', {
        url: 'https://example.com/',
        max_bytes: 0,
        output: 'raw',
      }),
    ValidationError,
  );
});

test('web_fetch surfaces network errors as thrown exceptions', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchError('ECONNREFUSED'), async () => {
    await assert.rejects(
      () =>
        tool.execute('call-web-8', {
          url: 'https://localhost:9/',
          output: 'raw',
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ECONNREFUSED/);
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

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(404, 'Not Found'), async () => {
    const result = await tool.execute('call-web-9', {
      url: 'https://example.com/missing',
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, 404);
    assert.match(getFirstText(result), /HTTP 404/);
  });
});

test('web_fetch output markdown extracts main content as Markdown', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'web_fetch');

  const html = `
<!DOCTYPE html>
<html>
<head><title>Test Article</title><meta name="author" content="Jane Doe"></head>
<body>
  <nav>Skip</nav>
  <main><article>
    <h1>Test Article</h1>
    <p>Main paragraph content here.</p>
  </article></main>
  <footer>Footer</footer>
</body>
</html>`;

  await withMockFetch(
    makeFetchMock(200, html, { 'content-type': 'text/html; charset=utf-8' }),
    async () => {
      const result = await tool.execute('call-web-defuddle', {
        url: 'https://example.com/article',
        output: 'markdown',
      });

      const details = result.details as Record<string, unknown>;
      assert.equal(details.output, 'markdown');
      assert.equal(details.status, 200);
      assert.ok(
        typeof details.title === 'string' || typeof details.contentBytes === 'number',
        'markdown output returns title or contentBytes',
      );

      const text = getFirstText(result);
      assert.match(text, /Main paragraph content here\./);
    },
  );
});

test('container_start launches a service container and returns entry details', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const fakeContainerId = 'abc123def456';
  const docker = new FakeDockerRunner([okResult({ stdout: `${fakeContainerId}\n` })]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'container_start');

  const result = await tool.execute('call-1', {
    name: 'pg-main',
    image: 'postgres:16',
    description: 'Main postgres instance',
    ports: { '5432': 10001 },
    env: { POSTGRES_PASSWORD: 'secret' },
  });

  assert.ok(docker.calls[0]?.includes('run'));
  assert.ok(docker.calls[0]?.includes('-d'));
  assert.ok(docker.calls[0]?.includes('pg-main'));
  assert.ok(docker.calls[0]?.includes('postgres:16'));
  assert.ok(docker.calls[0]?.includes('-p'));
  assert.ok(docker.calls[0]?.some((arg) => arg.includes('10001:5432')));

  const text = getFirstText(result);
  assert.match(text, /pg-main/);
  assert.match(text, /tailscale funnel/i);
  assert.match(text, /10001/);

  const entries = await containerManager.registry.readAll();
  const entry = entries.find((container) => container.name === 'pg-main');
  assert.ok(entry);
  assert.equal(entry?.status, 'running');
  assert.equal(entry?.image, 'postgres:16');
  assert.equal(entry?.description, 'Main postgres instance');
});

test('container_start resolves env_secrets and merges with plain env', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { DB_PASSWORD: 'supersecret', ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([okResult({ stdout: 'cid\n' })]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'container_start');

  await tool.execute('call-2', {
    name: 'redis-main',
    image: 'redis:7',
    env: { PLAIN_VAR: 'visible' },
    env_secrets: ['DB_PASSWORD'],
  });

  const envFlags = docker.calls[0]?.filter((_, index, args) => args[index - 1] === '-e') ?? [];
  assert.ok(envFlags.some((flag) => flag.startsWith('PLAIN_VAR=')), 'plain env var present');
  assert.ok(envFlags.some((flag) => flag.startsWith('DB_PASSWORD=')), 'secret env var present');

  const entry = (await containerManager.registry.readAll()).find((container) => container.name === 'redis-main');
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('supersecret'), 'secret value not in registry entry');
});

test('container_start is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'container_start');

  await assert.rejects(
    () => tool.execute('call-3', { name: 'blocked', image: 'alpine' }),
    ValidationError,
  );

  assert.equal(docker.calls.length, 0, 'docker should not be called in readonly mode');
});

test('container_stop stops a running service and updates the registry', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([
    okResult({ stdout: 'cid\n' }),
    okResult(),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await findTool(tools, 'container_start').execute('call-start', {
    name: 'svc-to-stop',
    image: 'nginx:alpine',
  });

  const stopResult = await findTool(tools, 'container_stop').execute('call-stop', {
    name: 'svc-to-stop',
  });

  assert.ok(docker.calls[1]?.includes('stop'));
  assert.ok(docker.calls[1]?.includes('svc-to-stop'));
  assert.match(getFirstText(stopResult), /svc-to-stop/);

  const entries = await containerManager.registry.readAll();
  const entry = entries.find((container) => container.name === 'svc-to-stop');
  assert.equal(entry?.status, 'stopped');
});

test('container_stop is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await assert.rejects(
    () => findTool(tools, 'container_stop').execute('call-4', { name: 'anything' }),
    ValidationError,
  );

  assert.equal(docker.calls.length, 0);
});

test('container_exec runs a command and returns stdout stderr exitCode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([
    okResult({ stdout: 'service-cid\n' }),
    okResult({ stdout: 'hello from container\n', stderr: '', exitCode: 0, durationMs: 12 }),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await registerService(containerManager, 'my-service', 'alpine:3.20');

  const result = await findTool(tools, 'container_exec').execute('call-5', {
    name: 'my-service',
    command: 'echo hello from container',
  });

  assert.ok(docker.calls[1]?.includes('exec'));
  assert.ok(docker.calls[1]?.includes('my-service'));

  const text = getFirstText(result);
  assert.match(text, /hello from container/);

  assert.equal((result.details as Record<string, unknown>).exitCode, 0);
  assert.match(String((result.details as Record<string, unknown>).stdout), /hello from container/);
});

test('container_exec surfaces non-zero exit code without throwing', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([
    okResult({ stdout: 'service-cid\n' }),
    okResult({ stdout: '', stderr: 'command not found: psql', exitCode: 127, durationMs: 3 }),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await registerService(containerManager, 'pg', 'postgres:16');

  const result = await findTool(tools, 'container_exec').execute('call-6', {
    name: 'pg',
    command: 'psql --version',
  });

  const details = result.details as Record<string, unknown>;
  assert.equal(details.exitCode, 127);
  assert.match(String(details.stderr), /command not found/);
});

test('container_exec parses structured output between sentinel markers', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const structuredStdout = [
    'some log line',
    '---OPENHERMIT_OUTPUT_START---',
    JSON.stringify({ rows: 42, table: 'users' }),
    '---OPENHERMIT_OUTPUT_END---',
  ].join('\n');

  const docker = new FakeDockerRunner([
    okResult({ stdout: 'service-cid\n' }),
    okResult({ stdout: structuredStdout, exitCode: 0, durationMs: 8 }),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await registerService(containerManager, 'pg', 'postgres:16');

  const result = await findTool(tools, 'container_exec').execute('call-7', {
    name: 'pg',
    command: 'node query.js',
  });

  const details = result.details as Record<string, unknown>;
  assert.ok(details.parsedOutput, 'parsedOutput should be present');
  assert.equal((details.parsedOutput as Record<string, unknown>).rows, 42);
});

test('container_exec is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await assert.rejects(
    () =>
      findTool(tools, 'container_exec').execute('call-8', {
        name: 'svc',
        command: 'echo hi',
      }),
    ValidationError,
  );

  assert.equal(docker.calls.length, 0);
});
