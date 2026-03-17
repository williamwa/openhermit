import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StreamFn } from '@mariozechner/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolCall,
  type Usage,
} from '@mariozechner/pi-ai';

import { AgentRunner } from '../src/agent-runner.js';
import type { LangfuseClientLike } from '../src/langfuse.js';
import { openInternalStateDatabase } from '../src/internal-state/sqlite.js';
import { SessionLogWriter } from '../src/session-logs.js';
import { createSecurityFixture } from './helpers.js';

const zeroUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const createAssistantMessage = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-opus-4-5',
  usage: zeroUsage,
  stopReason,
  timestamp: Date.now(),
});

const createTextResponseStream = (text: string) => {
  const stream = createAssistantMessageEventStream();
  const partial = createAssistantMessage(
    [
      {
        type: 'text',
        text,
      },
    ],
    'stop',
  );

  stream.push({
    type: 'start',
    partial: createAssistantMessage([], 'stop'),
  });
  stream.push({
    type: 'text_start',
    contentIndex: 0,
    partial,
  });
  stream.push({
    type: 'text_delta',
    contentIndex: 0,
    delta: text,
    partial,
  });
  stream.push({
    type: 'text_end',
    contentIndex: 0,
    content: text,
    partial,
  });
  stream.push({
    type: 'done',
    reason: 'stop',
    message: partial,
  });

  return stream;
};

const createToolCallResponseStream = (
  toolCall: ToolCall,
  options?: { prefixText?: string | undefined },
) => {
  const stream = createAssistantMessageEventStream();
  const content: AssistantMessage['content'] = [];

  if (options?.prefixText !== undefined) {
    content.push({
      type: 'text',
      text: options.prefixText,
    });
  }

  content.push(toolCall);

  const message = createAssistantMessage(content, 'toolUse');

  stream.push({
    type: 'start',
    partial: createAssistantMessage([], 'toolUse'),
  });
  stream.push({
    type: 'toolcall_start',
    contentIndex: 0,
    partial: message,
  });
  stream.push({
    type: 'toolcall_end',
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  stream.push({
    type: 'done',
    reason: 'toolUse',
    message,
  });

  return stream;
};

const createSequentialStreamFn = (
  responders: Array<(context: Context) => ReturnType<typeof createAssistantMessageEventStream>>,
): StreamFn => {
  let index = 0;

  return async (_model, context) => {
    const responder = responders[index];
    index += 1;

    if (!responder) {
      throw new Error(`Unexpected stream call #${index}`);
    }

    return responder(context);
  };
};

const readSessionLog = async (
  runner: AgentRunner,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> =>
  (await runner.listSessionLogEntries(sessionId)) as Array<Record<string, unknown>>;

class FakeLangfuseGeneration {
  readonly ended: Array<Record<string, unknown>> = [];

  end(body: Record<string, unknown>) {
    this.ended.push(body);
    return this;
  }
}

class FakeLangfuseTrace {
  readonly generations: Array<{
    body: Record<string, unknown>;
    client: FakeLangfuseGeneration;
  }> = [];

  readonly updates: Array<Record<string, unknown>> = [];

  generation(body: Record<string, unknown>) {
    const client = new FakeLangfuseGeneration();
    this.generations.push({ body, client });
    return client;
  }

  update(body: Record<string, unknown>) {
    this.updates.push(body);
    return this;
  }
}

class FakeLangfuseClient implements LangfuseClientLike {
  readonly traces: Array<{
    body: Record<string, unknown>;
    client: FakeLangfuseTrace;
  }> = [];

  async flushAsync(): Promise<void> {}

  trace(body: Record<string, unknown>) {
    const client = new FakeLangfuseTrace();
    this.traces.push({ body, client });
    return client;
  }
}

test('AgentRunner publishes SSE text events and writes minimal logs', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('hello from agent runner'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:test-session', {
    messageId: 'msg-1',
    text: 'hello',
  });
  await runner.waitForSessionIdle('cli:test-session');

  const backlog = runner.events.getBacklog('cli:test-session');

  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'text_delta' &&
        entry.event.text === 'hello from agent runner',
    ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'text_final' &&
        entry.event.text === 'hello from agent runner',
    ),
  );

  const sessionEntries = await readSessionLog(runner, 'cli:test-session');
  assert.ok(
    sessionEntries.some((entry) => entry.type === 'session_started'),
  );
  assert.ok(
    sessionEntries.some(
      (entry) => entry.role === 'user' && entry.content === 'hello',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'assistant' &&
        entry.content === 'hello from agent runner',
    ),
  );
});

test('AgentRunner injects runtime mission and container guidance into the system prompt', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  let capturedSystemPrompt = '';
  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedSystemPrompt = context.systemPrompt ?? '';
        return createTextResponseStream('captured');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:prompt-guidance',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:prompt-guidance', {
    text: 'Run a script in a container.',
  });
  await runner.waitForSessionIdle('cli:prompt-guidance');

  assert.match(capturedSystemPrompt, /You are a pragmatic AI agent operating inside a dedicated workspace/);
  assert.match(capturedSystemPrompt, /Your primary job is to help the user accomplish real tasks safely and effectively/);
  assert.match(capturedSystemPrompt, /Your specific identity, role, style, and priorities are defined by the workspace identity context/);
  assert.match(capturedSystemPrompt, /If the user wants to change your name, role, style, or other identity instructions, update the relevant files under `workspace\/\.openhermit\/`/);
  assert.match(capturedSystemPrompt, /Built-in tools are execution primitives, not product goals/);
  assert.match(capturedSystemPrompt, /Do not frame yourself as a container-management assistant/);
  assert.match(capturedSystemPrompt, /Container tool rules:/);
  assert.match(capturedSystemPrompt, /containers\/\{name\}\/data/);
  assert.match(capturedSystemPrompt, /Files under files\/ or the workspace root are not mounted automatically/);
  assert.match(capturedSystemPrompt, /You may choose the in-container mount target/);
  assert.match(capturedSystemPrompt, /Defaults are \/workspace for ephemeral runs and \/data for service containers/);
});

test('AgentRunner injects session-local working memory before now and main memory', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  let capturedMessages: Context['messages'] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('captured');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:working-context',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  const database = openInternalStateDatabase(security.stateFilePath);
  t.after(() => database.close());
  const logWriter = new SessionLogWriter(database);
  await logWriter.setSessionWorkingMemory(
    'cli:working-context',
    '# Session Working Memory\nsession local context\n',
    '2026-03-13T00:00:00.000Z',
  );
  await logWriter.setMemory(
    'now',
    '# Now Memory\ncurrent active work\n',
    '2026-03-13T00:00:00.000Z',
  );
  await logWriter.setMemory(
    'main',
    '# Main Memory\nstable user preference\n',
    '2026-03-13T00:00:00.000Z',
  );
  await runner.postMessage('cli:working-context', {
    text: 'use memory',
  });
  await runner.waitForSessionIdle('cli:working-context');

  assert.equal(capturedMessages[0]?.role, 'user');
  assert.match(
    JSON.stringify(capturedMessages[0]?.content ?? ''),
    /Session-local working memory/,
  );
  assert.equal(capturedMessages[1]?.role, 'user');
  assert.match(
    JSON.stringify(capturedMessages[1]?.content ?? ''),
    /Now memory/,
  );
  assert.equal(capturedMessages[2]?.role, 'user');
  assert.match(
    JSON.stringify(capturedMessages[2]?.content ?? ''),
    /Main memory/,
  );
});

test('AgentRunner compacts older context when the estimated prompt budget is exceeded', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const longUserA = 'alpha '.repeat(80).trim();
  const longAssistantA = 'response-alpha '.repeat(80).trim();
  const longUserB = 'beta '.repeat(80).trim();
  const longAssistantB = 'response-beta '.repeat(80).trim();
  let capturedMessages: Context['messages'] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    contextCompactionMaxTokens: 180,
    contextCompactionRecentMessageCount: 2,
    contextCompactionSummaryMaxChars: 800,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream(longAssistantA),
      () => createTextResponseStream(longAssistantB),
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('final reply');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:compaction-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:compaction-session', {
    text: longUserA,
  });
  await runner.waitForSessionIdle('cli:compaction-session');
  await runner.postMessage('cli:compaction-session', {
    text: longUserB,
  });
  await runner.waitForSessionIdle('cli:compaction-session');
  await runner.postMessage('cli:compaction-session', {
    text: 'gamma request',
  });
  await runner.waitForSessionIdle('cli:compaction-session');

  assert.ok(
    capturedMessages.some(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes('Context compaction summary'),
    ),
  );
  assert.ok(
    capturedMessages.some(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes('gamma request'),
    ),
  );
});

test('AgentRunner retains the assistant tool call when compaction keeps a trailing tool result', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();
  await workspace.writeFile('files/fact.txt', '42');

  let capturedMessages: Context['messages'] = [];
  const runner = await AgentRunner.create({
    workspace,
    security,
    contextCompactionMaxTokens: 120,
    contextCompactionRecentMessageCount: 1,
    contextCompactionSummaryMaxChars: 400,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('alpha response '.repeat(60).trim()),
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-read-file',
          name: 'read_file',
          arguments: {
            path: 'files/fact.txt',
          },
        }),
      (context) => {
        capturedMessages = context.messages;
        return createTextResponseStream('final reply');
      },
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:compaction-tool-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:compaction-tool-session', {
    text: 'alpha '.repeat(60).trim(),
  });
  await runner.waitForSessionIdle('cli:compaction-tool-session');
  await runner.postMessage('cli:compaction-tool-session', {
    text: 'Read the fact file.',
  });
  await runner.waitForSessionIdle('cli:compaction-tool-session');

  const retainedToolCall = capturedMessages.find(
    (message) =>
      message.role === 'assistant'
      && message.content.some((item) => item.type === 'toolCall' && item.name === 'read_file'),
  );
  const retainedToolResult = capturedMessages.find(
    (message) =>
      message.role === 'toolResult' && message.toolName === 'read_file',
  );

  assert.ok(retainedToolCall);
  assert.ok(retainedToolResult);
  assert.ok(
    capturedMessages.findIndex((message) => message === retainedToolCall)
      < capturedMessages.findIndex((message) => message === retainedToolResult),
  );
});

test('AgentRunner executes built-in tools through pi-agent-core', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();
  await workspace.writeFile('files/fact.txt', '42');

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-read-file',
          name: 'read_file',
          arguments: {
            path: 'files/fact.txt',
          },
        }),
      () => createTextResponseStream('The fact is 42.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tool-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tool-session', {
    text: 'Read the fact file.',
  });
  await runner.waitForSessionIdle('cli:tool-session');

  const backlog = runner.events.getBacklog('cli:tool-session');

  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'tool_requested' &&
        entry.event.tool === 'read_file' &&
        'args' in entry.event &&
        JSON.stringify(entry.event.args) === JSON.stringify({ path: 'files/fact.txt' }),
      ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'tool_started' &&
        entry.event.tool === 'read_file' &&
        'args' in entry.event &&
        JSON.stringify(entry.event.args) === JSON.stringify({ path: 'files/fact.txt' }),
      ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'tool_result' &&
        entry.event.tool === 'read_file' &&
        entry.event.isError === false &&
        typeof entry.event.text === 'string' &&
        entry.event.text.includes('42'),
    ),
  );
  assert.ok(
    backlog.some(
      (entry) =>
        entry.event.type === 'text_final' &&
        entry.event.text === 'The fact is 42.',
    ),
  );

  const sessionEntries = await readSessionLog(runner, 'cli:tool-session');

  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'tool_call' &&
        entry.type === 'tool_requested' &&
        entry.name === 'read_file',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'tool_call' &&
        entry.type === 'tool_started' &&
        entry.name === 'read_file',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'tool_result' &&
        typeof entry.content === 'string' &&
        entry.content.includes('42'),
    ),
  );
});

test('AgentRunner ignores whitespace-only assistant messages emitted before tool use', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();
  await workspace.writeFile('files/fact.txt', '42');

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-read-file',
          name: 'read_file',
          arguments: {
            path: 'files/fact.txt',
          },
        }, { prefixText: ' ' }),
      () => createTextResponseStream('The fact is 42.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tool-whitespace-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tool-whitespace-session', {
    text: 'Read the fact file.',
  });
  await runner.waitForSessionIdle('cli:tool-whitespace-session');

  const backlog = runner.events.getBacklog('cli:tool-whitespace-session');
  const eventTypes = backlog.map((entry) => entry.event.type);
  const toolResultIndex = eventTypes.indexOf('tool_result');
  const finalTextIndex = eventTypes.lastIndexOf('text_final');

  assert.notEqual(toolResultIndex, -1);
  assert.notEqual(finalTextIndex, -1);
  assert.ok(toolResultIndex < finalTextIndex);
  assert.equal(
    backlog.filter((entry) => entry.event.type === 'text_final').length,
    1,
  );

  const sessionEntries = await readSessionLog(runner, 'cli:tool-whitespace-session');
  const assistantEntries = sessionEntries.filter((entry) => entry.role === 'assistant');

  assert.equal(assistantEntries.length, 1);
  assert.equal(assistantEntries[0]?.content, 'The fact is 42.');

  const history = await runner.listSessionMessages('cli:tool-whitespace-session');
  const assistantHistory = history.filter((entry) => entry.role === 'assistant');

  assert.equal(assistantHistory.length, 1);
  assert.equal(assistantHistory[0]?.content, 'The fact is 42.');
});

test('AgentRunner writes episodic checkpoints on explicit checkpoint requests and remembers the last cursor', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
      () => createTextResponseStream('second reply'),
    ]),
    checkpointSummaryGenerator: async ({ history, reason }) =>
      `${reason}: ${history.map((entry) => `${entry.role}:${entry.content}`).join(' | ')}`,
    sessionWorkingMemoryGenerator: async ({
      previousWorkingMemory,
      checkpointSummary,
      reason,
    }) =>
      [
        `reason=${reason}`,
        `summary=${checkpointSummary}`,
        `previous=${previousWorkingMemory?.replace(/\n/g, ' ') ?? '(none)'}`,
      ].join('\n'),
  });

  await runner.openSession({
    sessionId: 'cli:checkpoint-session',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:checkpoint-session', { text: 'first question' });
  await runner.waitForSessionIdle('cli:checkpoint-session');

  assert.equal(
    await runner.checkpointSession('cli:checkpoint-session', 'new_session'),
    true,
  );
  assert.equal(
    await runner.checkpointSession('cli:checkpoint-session', 'new_session'),
    false,
  );

  await runner.postMessage('cli:checkpoint-session', { text: 'second question' });
  await runner.waitForSessionIdle('cli:checkpoint-session');

  assert.equal(
    await runner.checkpointSession('cli:checkpoint-session', 'manual'),
    true,
  );

  const episodicEntries = await runner.listEpisodicEntries('cli:checkpoint-session');
  const firstData = episodicEntries[0]?.data as Record<string, unknown> | undefined;
  const secondData = episodicEntries[1]?.data as Record<string, unknown> | undefined;

  assert.equal(episodicEntries.length, 2);
  assert.equal(episodicEntries[0]?.type, 'session_summary');
  assert.equal(episodicEntries[1]?.type, 'session_summary');
  assert.equal(firstData?.reason, 'new_session');
  assert.equal(secondData?.reason, 'manual');
  assert.match(String(firstData?.summary ?? ''), /first question/);
  assert.doesNotMatch(String(secondData?.summary ?? ''), /first question/);
  assert.match(String(secondData?.summary ?? ''), /second question/);

  const database = openInternalStateDatabase(security.stateFilePath);
  t.after(() => database.close());
  const logWriter = new SessionLogWriter(database);
  const workingMemory = await logWriter.getSessionWorkingMemory(
    'cli:checkpoint-session',
  );
  assert.ok(workingMemory);
  assert.match(workingMemory, /reason=manual/);
  assert.match(workingMemory, /summary=manual: user:second question \| assistant:second reply/);
  assert.match(workingMemory, /previous=reason=new_session/);
});

test('AgentRunner uses an internal checkpoint turn by default instead of an external summary call', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
      () =>
        createTextResponseStream(
          JSON.stringify({
            summary: 'internal summary for checkpoint',
            sessionWorkingMemory: '# Session Working Memory\n\nremember this',
          }),
        ),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:internal-checkpoint-session',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:internal-checkpoint-session', { text: 'first question' });
  await runner.waitForSessionIdle('cli:internal-checkpoint-session');

  assert.equal(
    await runner.checkpointSession('cli:internal-checkpoint-session', 'manual'),
    true,
  );

  const episodicEntries = await runner.listEpisodicEntries('cli:internal-checkpoint-session');
  const checkpointData = episodicEntries[0]?.data as Record<string, unknown> | undefined;

  assert.equal(episodicEntries.length, 1);
  assert.equal(checkpointData?.summary, 'internal summary for checkpoint');

  const database = openInternalStateDatabase(security.stateFilePath);
  t.after(() => database.close());
  const logWriter = new SessionLogWriter(database);
  const workingMemory = await logWriter.getSessionWorkingMemory(
    'cli:internal-checkpoint-session',
  );

  assert.equal(workingMemory, '# Session Working Memory\n\nremember this\n');
});

test('AgentRunner writes a checkpoint automatically every configured turn interval', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('turn one'),
      () =>
        createTextResponseStream(
          JSON.stringify({
            summary: 'turn_limit: checkpoint me | turn one',
            sessionWorkingMemory: '# Session Working Memory\n\nturn one context',
          }),
        ),
    ]),
    checkpointTurnInterval: 1,
    checkpointSummaryGenerator: async ({ history, reason }) =>
      `${reason}: ${history.map((entry) => entry.content).join(' | ')}`,
  });

  await runner.openSession({
    sessionId: 'cli:turn-checkpoint',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:turn-checkpoint', { text: 'checkpoint me' });
  await runner.waitForSessionIdle('cli:turn-checkpoint');

  const episodicEntries = await runner.listEpisodicEntries('cli:turn-checkpoint');
  const checkpointData = episodicEntries[0]?.data as Record<string, unknown> | undefined;

  assert.equal(episodicEntries.length, 1);
  assert.equal(episodicEntries[0]?.type, 'session_checkpoint');
  assert.equal(checkpointData?.reason, 'turn_limit');
});

test('AgentRunner counts one completed turn per agent run even with multiple assistant messages', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();
  await workspace.writeFile('files/fact.txt', '42');

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream(
          {
            type: 'toolCall',
            id: 'call-read-file',
            name: 'read_file',
            arguments: {
              path: 'files/fact.txt',
            },
          },
          { prefixText: 'I will inspect the fact file first.' },
        ),
      () => createTextResponseStream('The fact is 42.'),
      () => createTextResponseStream('second run reply'),
    ]),
    checkpointTurnInterval: 2,
    checkpointSummaryGenerator: async ({ history, reason }) =>
      `${reason}: ${history.map((entry) => entry.content).join(' | ')}`,
    sessionWorkingMemoryGenerator: async ({ checkpointSummary }) =>
      `# Session Working Memory\n\n${checkpointSummary}`,
  });

  await runner.openSession({
    sessionId: 'cli:run-turn-count',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:run-turn-count', {
    text: 'Read the fact file and explain it.',
  });
  await runner.waitForSessionIdle('cli:run-turn-count');

  assert.equal(
    (await runner.listEpisodicEntries('cli:run-turn-count')).length,
    0,
  );

  await runner.postMessage('cli:run-turn-count', {
    text: 'Say something else.',
  });
  await runner.waitForSessionIdle('cli:run-turn-count');

  const episodicEntries = await runner.listEpisodicEntries('cli:run-turn-count');
  const checkpointData = episodicEntries[0]?.data as Record<string, unknown> | undefined;

  assert.equal(episodicEntries.length, 1);
  assert.equal(checkpointData?.reason, 'turn_limit');
  assert.equal(checkpointData?.turnCount, 2);
});

test('AgentRunner writes an idle summary after the configured timeout', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('idle reply'),
      () =>
        createTextResponseStream(
          JSON.stringify({
            summary: 'idle: wait for idle | idle reply',
            sessionWorkingMemory: '# Session Working Memory\n\nidle context',
          }),
        ),
    ]),
    idleSummaryTimeoutMs: 20,
    checkpointSummaryGenerator: async ({ history, reason }) =>
      `${reason}: ${history.map((entry) => entry.content).join(' | ')}`,
  });

  await runner.openSession({
    sessionId: 'cli:idle-checkpoint',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:idle-checkpoint', { text: 'wait for idle' });
  await runner.waitForSessionIdle('cli:idle-checkpoint');
  await new Promise((resolve) => setTimeout(resolve, 40));
  await runner.waitForSessionIdle('cli:idle-checkpoint');

  const episodicEntries = await runner.listEpisodicEntries('cli:idle-checkpoint');
  const idleData = episodicEntries[0]?.data as Record<string, unknown> | undefined;

  assert.equal(episodicEntries.length, 1);
  assert.equal(episodicEntries[0]?.type, 'session_summary');
  assert.equal(idleData?.reason, 'idle');
});

test('AgentRunner surfaces a missing API key as an error event instead of crashing', async (t) => {
  const { workspace, security } = await createSecurityFixture(t);
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
  });

  await runner.openSession({
    sessionId: 'cli:no-key-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:no-key-session', {
    text: 'hello',
  });
  await runner.waitForSessionIdle('cli:no-key-session');

  const backlog = runner.events.getBacklog('cli:no-key-session');
  const errorEvent = backlog.find((entry) => entry.event.type === 'error');

  assert.ok(errorEvent);
  assert.match(
    errorEvent?.event.type === 'error' ? errorEvent.event.message : '',
    /Missing API key for provider "anthropic"/,
  );

  const sessionEntries = await readSessionLog(runner, 'cli:no-key-session');

  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.role === 'error' &&
        typeof entry.message === 'string' &&
        entry.message.includes('Missing API key for provider "anthropic"'),
    ),
  );
});

test('AgentRunner pauses on require_approval_for and resumes after respondToApproval', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['write_file'],
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-write',
          name: 'write_file',
          arguments: { path: 'files/out.txt', content: 'approved content' },
        }),
      () => createTextResponseStream('File written successfully.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:approval-session',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:approval-session', { text: 'Write a file.' });

  // Wait until tool_approval_required is published (agent is paused waiting for gate)
  await new Promise<void>((resolve) => {
    const check = (): void => {
      const backlog = runner.events.getBacklog('cli:approval-session');
      if (backlog.some((e) => e.event.type === 'tool_approval_required')) {
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });

  const backlogBefore = runner.events.getBacklog('cli:approval-session');
  const sessionSummariesWhilePaused = await runner.listSessions({ kind: 'cli' });
  assert.equal(sessionSummariesWhilePaused.length, 1);
  assert.equal(sessionSummariesWhilePaused[0]?.status, 'awaiting_approval');
  assert.equal(sessionSummariesWhilePaused[0]?.lastMessagePreview, 'Write a file.');
  assert.ok(
    backlogBefore.some((e) => e.event.type === 'tool_approval_required'),
    'tool_approval_required event was published',
  );
  assert.ok(
    backlogBefore.some((e) => e.event.type === 'tool_requested' && e.event.tool === 'write_file'),
    'tool_requested is published before approval resolves',
  );
  assert.ok(
    !backlogBefore.some((e) => e.event.type === 'tool_started' && e.event.tool === 'write_file'),
    'tool_started is not published before approval resolves',
  );
  const approvalEvent = backlogBefore.find((e) => e.event.type === 'tool_approval_required');
  assert.equal(approvalEvent?.event.type, 'tool_approval_required');

  if (approvalEvent?.event.type === 'tool_approval_required') {
    assert.equal(approvalEvent.event.toolName, 'write_file');

    // Approve the tool call
    const resolved = runner.respondToApproval(
      'cli:approval-session',
      approvalEvent.event.toolCallId,
      true,
    );
    assert.equal(resolved, true, 'respondToApproval found the pending gate');
  }

  await runner.waitForSessionIdle('cli:approval-session');

  const sessionSummariesAfterApproval = await runner.listSessions({ kind: 'cli' });
  assert.equal(sessionSummariesAfterApproval.length, 1);
  assert.equal(sessionSummariesAfterApproval[0]?.status, 'idle');
  assert.equal(
    sessionSummariesAfterApproval[0]?.lastMessagePreview,
    'File written successfully.',
  );
  assert.equal(sessionSummariesAfterApproval[0]?.messageCount, 2);

  const backlogAfter = runner.events.getBacklog('cli:approval-session');
  assert.ok(
    backlogAfter.some((e) => e.event.type === 'tool_started' && e.event.tool === 'write_file'),
    'write_file only starts after approval',
  );
  assert.ok(
    backlogAfter.some((e) => e.event.type === 'tool_result' && e.event.tool === 'write_file' && !e.event.isError),
    'write_file completed successfully after approval',
  );
  assert.ok(
    backlogAfter.some((e) => e.event.type === 'text_final'),
    'agent produced a final reply',
  );
  const fileContent = await workspace.readFile('files/out.txt');
  assert.equal(fileContent, 'approved content');

  const sessionEntries = await readSessionLog(runner, 'cli:approval-session');
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.type === 'tool_approval_requested' &&
        entry.toolName === 'write_file',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.type === 'tool_approval_resolved' &&
        entry.toolName === 'write_file' &&
        entry.decision === 'approved',
    ),
  );
});

test('AgentRunner rejects tool call when respondToApproval sends false', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['write_file'],
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-write-denied',
          name: 'write_file',
          arguments: { path: 'files/blocked.txt', content: 'should not appear' },
        }),
      () => createTextResponseStream('The write was rejected by the user.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:deny-session',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:deny-session', { text: 'Write a file.' });

  // Wait for approval event
  await new Promise<void>((resolve) => {
    const check = (): void => {
      const backlog = runner.events.getBacklog('cli:deny-session');
      if (backlog.some((e) => e.event.type === 'tool_approval_required')) {
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });

  const approvalEvent = runner.events
    .getBacklog('cli:deny-session')
    .find((e) => e.event.type === 'tool_approval_required');

  if (approvalEvent?.event.type === 'tool_approval_required') {
    runner.respondToApproval('cli:deny-session', approvalEvent.event.toolCallId, false);
  }

  await runner.waitForSessionIdle('cli:deny-session');

  // File must NOT have been created
  const fileExists = await workspace.readFile('files/blocked.txt').then(() => true, () => false);
  assert.equal(fileExists, false, 'rejected write_file must not create the file');

  const backlog = runner.events.getBacklog('cli:deny-session');
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_requested' && e.event.tool === 'write_file'),
    'tool_requested is still published before a denied approval',
  );
  assert.ok(
    !backlog.some((e) => e.event.type === 'tool_started' && e.event.tool === 'write_file'),
    'tool_started is not published when approval is denied',
  );
  const toolResult = backlog.find((e) => e.event.type === 'tool_result' && e.event.tool === 'write_file');
  assert.ok(toolResult, 'tool_result event was published');
  assert.equal(
    toolResult?.event.type === 'tool_result' ? toolResult.event.isError : undefined,
    false,
    'rejection is returned as a non-error tool result with a message',
  );
  assert.match(
    toolResult?.event.type === 'tool_result' && typeof toolResult.event.text === 'string'
      ? toolResult.event.text
      : '',
    /rejected by the user/,
  );

  const sessionEntries = await readSessionLog(runner, 'cli:deny-session');
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.type === 'tool_approval_requested' &&
        entry.toolName === 'write_file',
    ),
  );
  assert.ok(
    sessionEntries.some(
      (entry) =>
        entry.type === 'tool_approval_resolved' &&
        entry.toolName === 'write_file' &&
        entry.decision === 'rejected',
    ),
  );
});

test('AgentRunner skips approval for full autonomy level', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    security: {
      autonomy_level: 'full',
      require_approval_for: ['write_file'],
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-write-full',
          name: 'write_file',
          arguments: { path: 'files/auto.txt', content: 'no approval needed' },
        }),
      () => createTextResponseStream('Done.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:full-autonomy',
    source: { kind: 'cli', interactive: true },
  });
  await runner.postMessage('cli:full-autonomy', { text: 'Write a file.' });
  await runner.waitForSessionIdle('cli:full-autonomy');

  const backlog = runner.events.getBacklog('cli:full-autonomy');
  assert.ok(
    !backlog.some((e) => e.event.type === 'tool_approval_required'),
    'no approval event for full autonomy',
  );
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_requested' && e.event.tool === 'write_file'),
    'tool_requested is published for full autonomy',
  );
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_started' && e.event.tool === 'write_file'),
    'tool_started is published for full autonomy',
  );
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_result' && e.event.tool === 'write_file' && !e.event.isError),
    'write_file ran without approval in full mode',
  );
  const content = await workspace.readFile('files/auto.txt');
  assert.equal(content, 'no approval needed');
});

test('AgentRunner skips approval for non-interactive sessions', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'test-anthropic-key' },
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['write_file'],
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-write-heartbeat',
          name: 'write_file',
          arguments: { path: 'files/heartbeat.txt', content: 'from heartbeat' },
        }),
      () => createTextResponseStream('Heartbeat complete.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'heartbeat:1234',
    source: { kind: 'heartbeat', interactive: false },
  });
  await runner.postMessage('heartbeat:1234', { text: 'Run maintenance.' });
  await runner.waitForSessionIdle('heartbeat:1234');

  const backlog = runner.events.getBacklog('heartbeat:1234');
  assert.ok(
    !backlog.some((e) => e.event.type === 'tool_approval_required'),
    'no approval event for non-interactive session',
  );
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_requested' && e.event.tool === 'write_file'),
    'tool_requested is published for non-interactive sessions',
  );
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_started' && e.event.tool === 'write_file'),
    'tool_started is published for non-interactive sessions',
  );
  assert.ok(
    backlog.some((e) => e.event.type === 'tool_result' && e.event.tool === 'write_file' && !e.event.isError),
    'write_file ran without approval in non-interactive mode',
  );
  const content = await workspace.readFile('files/heartbeat.txt');
  assert.equal(content, 'from heartbeat');
});

test('AgentRunner publishes detailed tool failure messages', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () =>
        createToolCallResponseStream({
          type: 'toolCall',
          id: 'call-container-run',
          name: 'container_run',
          arguments: {
            image: 'python:3.12',
            command: 'python /workspace/test.py',
            mount: 'files',
          },
        }),
      () => createTextResponseStream('The container run failed because the mount path was invalid.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:tool-error-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:tool-error-session', {
    text: 'Run the Python script in a container.',
  });
  await runner.waitForSessionIdle('cli:tool-error-session');

  const backlog = runner.events.getBacklog('cli:tool-error-session');
  const toolResultEvent = backlog.find(
    (entry) => entry.event.type === 'tool_result' && entry.event.tool === 'container_run',
  );

  assert.ok(toolResultEvent);
  assert.equal(toolResultEvent?.event.type, 'tool_result');
  assert.equal(toolResultEvent?.event.isError, true);
  assert.match(
    toolResultEvent?.event.type === 'tool_result' && typeof toolResultEvent.event.text === 'string'
      ? toolResultEvent.event.text
      : '',
    /Ephemeral mount path must stay under containers\/\{name\}\/data: files/,
  );
});

test('AgentRunner rebuilds and reuses persisted session index across restarts', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:persisted-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:persisted-session', {
    text: 'hello persistence',
  });
  await runner.waitForSessionIdle('cli:persisted-session');

  const indexedSessions = await runner.listSessions({ kind: 'cli' });
  assert.equal(indexedSessions.length, 1);
  assert.equal(indexedSessions[0]?.sessionId, 'cli:persisted-session');

  const restoredRunner = await AgentRunner.create({
    workspace,
    security,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('second reply'),
    ]),
  });

  const restoredSessions = await restoredRunner.listSessions({ kind: 'cli' });
  assert.equal(restoredSessions.length, 1);
  assert.equal(restoredSessions[0]?.sessionId, 'cli:persisted-session');
  assert.equal(restoredSessions[0]?.status, 'idle');
  assert.equal(restoredSessions[0]?.lastEventId, 0);
  assert.equal(restoredSessions[0]?.messageCount, 2);
  assert.equal(restoredSessions[0]?.description, 'hello persistence');
  assert.equal(restoredSessions[0]?.lastMessagePreview, 'first reply');

  await restoredRunner.openSession({
    sessionId: 'cli:persisted-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });

  await restoredRunner.postMessage('cli:persisted-session', {
    text: 'continue persistence',
  });
  await restoredRunner.waitForSessionIdle('cli:persisted-session');

  const sessionEntries = await readSessionLog(
    restoredRunner,
    'cli:persisted-session',
  );
  assert.equal(
    sessionEntries.filter((entry) => entry.type === 'session_started').length,
    1,
  );
  assert.ok(
    sessionEntries.some(
      (entry) => entry.role === 'assistant' && entry.content === 'second reply',
    ),
  );
});

test('AgentRunner stores an AI-generated session description when available', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const runner = await AgentRunner.create({
    workspace,
    security,
    sessionDescriptionGenerator: async () => 'Investigate flaky container mount retries',
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('I inspected the mount failure and found the root cause.'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:described-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:described-session', {
    text: 'Please debug why the container mount keeps failing.',
  });
  await runner.waitForSessionIdle('cli:described-session');

  const sessions = await runner.listSessions({ kind: 'cli' });
  assert.equal(sessions[0]?.description, 'Investigate flaky container mount retries');
});

test('AgentRunner emits Langfuse traces for LLM steps', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const langfuse = new FakeLangfuseClient();
  const runner = await AgentRunner.create({
    workspace,
    security,
    langfuse,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('hello with trace'),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:langfuse-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:langfuse-session', {
    text: 'trace this request',
  });
  await runner.waitForSessionIdle('cli:langfuse-session');

  assert.equal(langfuse.traces.length, 1);
  assert.equal(langfuse.traces[0]?.body.name, 'openhermit.llm_step');
  assert.equal(langfuse.traces[0]?.body.sessionId, 'cli:langfuse-session');
  assert.equal(langfuse.traces[0]?.client.generations.length, 1);
  assert.equal(
    langfuse.traces[0]?.client.generations[0]?.body.model,
    'claude-opus-4-5',
  );
  assert.equal(
    (langfuse.traces[0]?.client.generations[0]?.body.metadata as Record<string, unknown>)?.requestKind,
    'llm-step',
  );
  assert.equal(
    ((langfuse.traces[0]?.client.generations[0]?.body.input as Record<string, unknown>)?.messages as Array<Record<string, unknown>>)[0]?.role,
    'user',
  );
  assert.equal(
    ((langfuse.traces[0]?.client.generations[0]?.client.ended[0]?.output as Record<string, unknown>)?.model),
    'claude-opus-4-5',
  );
  assert.equal(
    (((langfuse.traces[0]?.client.generations[0]?.client.ended[0]?.output as Record<string, unknown>)?.content as Array<Record<string, unknown>>)[0]?.text),
    'hello with trace',
  );
});

test('AgentRunner uses a dedicated Langfuse trace name for internal checkpoints', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  });
  await security.load();

  const langfuse = new FakeLangfuseClient();
  const runner = await AgentRunner.create({
    workspace,
    security,
    langfuse,
    streamFn: createSequentialStreamFn([
      () => createTextResponseStream('first reply'),
      () =>
        createTextResponseStream(
          JSON.stringify({
            summary: 'checkpoint summary',
            sessionWorkingMemory: '# Session Working Memory\ncheckpoint memory',
          }),
        ),
    ]),
  });

  await runner.openSession({
    sessionId: 'cli:checkpoint-trace',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runner.postMessage('cli:checkpoint-trace', {
    text: 'checkpoint this session',
  });
  await runner.waitForSessionIdle('cli:checkpoint-trace');
  await runner.checkpointSession('cli:checkpoint-trace', 'manual');

  assert.equal(langfuse.traces[0]?.body.name, 'openhermit.llm_step');
  assert.equal(langfuse.traces[1]?.body.name, 'openhermit.session_checkpoint');
  assert.equal(
    (langfuse.traces[1]?.body.metadata as Record<string, unknown>)?.requestKind,
    'session-checkpoint',
  );
  assert.equal(
    (langfuse.traces[1]?.body.metadata as Record<string, unknown>)?.checkpointReason,
    'manual',
  );
});
