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
import { DefuddleWebProvider } from '../src/web/index.js';
import { createSecurityFixture, createTempDir } from './helpers.js';

const defaultWebProvider = new DefuddleWebProvider();

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

test('withApproval caches container_start approval by name within a session', async (t) => {
  const { security } = await createSecurityFixture(t, {
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['container_start'],
    },
  });
  await security.load();

  const Params = Type.Object({
    name: Type.String(),
    image: Type.String(),
  });

  let execCount = 0;
  const tool: AgentTool<typeof Params> = {
    name: 'container_start',
    label: 'Start Service Container',
    description: 'test',
    parameters: Params,
    execute: async () => {
      execCount += 1;
      return { content: [{ type: 'text', text: 'started' }], details: {} };
    },
  };

  let approvalCount = 0;
  const cache = new Set<string>();
  const wrapped = withApproval(
    tool,
    security,
    async () => { approvalCount += 1; return 'approved'; },
    undefined,
    undefined,
    cache,
  );

  await wrapped.execute('call-1', { name: 'web', image: 'nginx' });
  await wrapped.execute('call-2', { name: 'web', image: 'nginx' });
  await wrapped.execute('call-3', { name: 'db', image: 'postgres' });

  assert.equal(execCount, 3);
  assert.equal(approvalCount, 2, 'second call to same name should skip approval');
});

test('memory_add stores entry, memory_recall finds it, and memory_get returns full content', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryProvider = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    security,
    containerManager,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const addTool = findTool(tools, 'memory_add');
  const getTool = findTool(tools, 'memory_get');
  const recallTool = findTool(tools, 'memory_recall');

  const addResult = await addTool.execute('call-memory-add', {
    id: 'lang-pref',
    content: 'The user prefers TypeScript for new examples.',
    metadata: { title: 'Language preference' },
  });

  const addDetails = addResult.details as Record<string, unknown>;
  assert.equal(addDetails.id, 'lang-pref');

  const recallResult = await recallTool.execute('call-memory-recall', {
    query: 'TypeScript',
    limit: 3,
  });

  const recallText = getFirstText(recallResult);
  assert.match(recallText, /TypeScript/);

  const recallDetails = recallResult.details as Record<string, unknown>;
  assert.equal(recallDetails.query, 'TypeScript');
  assert.equal(recallDetails.count, 1);

  const getResult = await getTool.execute('call-memory-get', {
    id: 'lang-pref',
  });
  const getDetails = getResult.details as Record<string, unknown>;
  assert.equal(getDetails.id, 'lang-pref');
  assert.equal(
    getDetails.content,
    'The user prefers TypeScript for new examples.',
  );
});

test('memory_add creates entries and memory_recall searches them', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryProvider = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    security,
    containerManager,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const addTool = findTool(tools, 'memory_add');
  const recallTool = findTool(tools, 'memory_recall');

  await addTool.execute('call-memory-add-focus', {
    id: 'current-focus',
    content: 'I am currently working in session:web:abc on the OpenHermit web UI.',
  });
  await addTool.execute('call-memory-add-project', {
    id: 'project/openhermit/plan',
    content: 'Next up: scheduler and identity split.',
  });

  const recallResult = await recallTool.execute('call-memory-recall-search', {
    query: 'scheduler',
  });

  const recallDetails = recallResult.details as Record<string, unknown>;
  assert.equal(recallDetails.count, 1);
  assert.equal(
    (recallDetails.matches as Array<Record<string, unknown>>)[0]?.id,
    'project/openhermit/plan',
  );
});

test('memory_get rejects unknown IDs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const store = SqliteInternalStateStore.open(security.stateFilePath);
  t.after(() => store.close());
  const memoryProvider = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    security,
    containerManager,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const getTool = findTool(tools, 'memory_get');

  await assert.rejects(
    () =>
      getTool.execute('call-memory-get-missing', {
        id: 'project/missing',
      }),
    (error: unknown) =>
      error instanceof ValidationError
      && /Memory not found: project\/missing/.test(error.message),
  );
});

test('memory_add is blocked in readonly mode', async (t) => {
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
  const memoryProvider = store.memories;
  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
    stateFilePath: security.stateFilePath,
  });
  const tools = createBuiltInTools({
    security,
    containerManager,
    memoryProvider,
    storeScope: standaloneScope,
  });
  const addTool = findTool(tools, 'memory_add');

  await assert.rejects(
    () =>
      addTool.execute('call-memory-readonly', {
        content: 'Remember this forever.',
      }),
    ValidationError,
  );
});

test('web_fetch returns status headers and body for a successful GET', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const containerManager = new DockerContainerManager(workspace, {
    runner: new FakeDockerRunner([]),
  });
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(
    makeFetchMock(200, 'Hello, world!', { 'content-type': 'text/plain' }),
    async () => {
      const result = await tool.execute('call-web-1', {
        url: 'https://example.com/',
        output: 'raw',
      });

      const text = getFirstText(result);
      assert.match(text, /Hello, world!/);

      const details = result.details as Record<string, unknown>;
      assert.equal(details.url, 'https://example.com/');
      assert.equal(details.output, 'raw');
      assert.equal(details.contentBytes, 13);
      assert.equal(details.truncated, false);
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
    security,
    containerManager,
    webProvider: defaultWebProvider,
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
    assert.match(getFirstText(result), /ok/);
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, bigBody), async () => {
    const result = await tool.execute('call-web-3', {
      url: 'https://example.com/big',
      max_bytes: 100,
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, true);
    assert.equal(details.contentBytes, 500);
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(200, 'small body'), async () => {
    const result = await tool.execute('call-web-4', {
      url: 'https://example.com/',
      max_bytes: 999_999_999,
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.truncated, false);
    assert.match(getFirstText(result), /small body/);
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
  const tool = findTool(tools, 'web_fetch');

  await withMockFetch(makeFetchMock(404, 'Not Found'), async () => {
    const result = await tool.execute('call-web-9', {
      url: 'https://example.com/missing',
      output: 'raw',
    });

    const details = result.details as Record<string, unknown>;
    assert.equal(details.status, 404);
    assert.match(getFirstText(result), /Not Found/);
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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

test('instruction_update stores an entry and instruction_read retrieves it', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const stateStore = SqliteInternalStateStore.open(
    path.join(await createTempDir(t, 'instruction-test-'), 'state.sqlite'),
  );
  t.after(() => stateStore.close());

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const scope = { agentId: 'agent-test' };
  const tools = createBuiltInTools({
    security,
    containerManager,
    instructionStore: stateStore.instructions,
    storeScope: scope,
  });

  const updateTool = findTool(tools, 'instruction_update');
  await updateTool.execute('call-id-1', {
    key: 'identity',
    content: '# IDENTITY\n\nName: TestBot\nRole: A test agent.',
  });

  const readTool = findTool(tools, 'instruction_read');
  const singleResult = await readTool.execute('call-id-2', { key: 'identity' });
  assert.match(getFirstText(singleResult), /TestBot/);

  await updateTool.execute('call-id-3', {
    key: 'soul',
    content: '# SOUL\n\nValues:\n- precision',
  });

  const allResult = await readTool.execute('call-id-4', {});
  const allText = getFirstText(allResult);
  assert.match(allText, /identity/);
  assert.match(allText, /soul/);
});

test('instruction_read returns empty message when no entries exist', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const stateStore = SqliteInternalStateStore.open(
    path.join(await createTempDir(t, 'instruction-test-'), 'state.sqlite'),
  );
  t.after(() => stateStore.close());

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({
    security,
    containerManager,
    instructionStore: stateStore.instructions,
    storeScope: { agentId: 'agent-test' },
  });

  const result = await findTool(tools, 'instruction_read').execute('call-id-5', {});
  assert.match(getFirstText(result), /No instruction entries found/);
});

test('instruction_update is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const stateStore = SqliteInternalStateStore.open(
    path.join(await createTempDir(t, 'instruction-test-'), 'state.sqlite'),
  );
  t.after(() => stateStore.close());

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({
    security,
    containerManager,
    instructionStore: stateStore.instructions,
    storeScope: { agentId: 'agent-test' },
  });

  await assert.rejects(
    () => findTool(tools, 'instruction_update').execute('call-id-6', {
      key: 'identity',
      content: 'should be blocked',
    }),
    ValidationError,
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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
  assert.ok(docker.calls[0]?.includes('openhermit-default-pg-main'));
  assert.ok(docker.calls[0]?.includes('postgres:16'));
  assert.ok(docker.calls[0]?.includes('-p'));
  assert.ok(docker.calls[0]?.some((arg) => arg.includes('10001:5432')));

  const text = getFirstText(result);
  assert.match(text, /pg-main/);
  assert.match(text, /tailscale funnel/i);
  assert.match(text, /10001/);

  const entries = await containerManager.registry.readAll();
  const entry = entries.find((container) => container.name === 'openhermit-default-pg-main');
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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

  const entry = (await containerManager.registry.readAll()).find((container) => container.name === 'openhermit-default-redis-main');
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });

  await findTool(tools, 'container_start').execute('call-start', {
    name: 'svc-to-stop',
    image: 'nginx:alpine',
  });

  const stopResult = await findTool(tools, 'container_stop').execute('call-stop', {
    name: 'svc-to-stop',
  });

  assert.ok(docker.calls[1]?.includes('stop'));
  assert.ok(docker.calls[1]?.includes('openhermit-default-svc-to-stop'));
  assert.match(getFirstText(stopResult), /svc-to-stop/);

  const entries = await containerManager.registry.readAll();
  const entry = entries.find((container) => container.name === 'openhermit-default-svc-to-stop');
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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });

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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });

  await registerService(containerManager, 'my-service', 'alpine:3.20');

  const result = await findTool(tools, 'container_exec').execute('call-5', {
    name: 'my-service',
    command: 'echo hello from container',
  });

  assert.ok(docker.calls[1]?.includes('exec'));
  assert.ok(docker.calls[1]?.includes('openhermit-default-my-service'));

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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });

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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });

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
  const tools = createBuiltInTools({ security, containerManager, webProvider: defaultWebProvider });

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
