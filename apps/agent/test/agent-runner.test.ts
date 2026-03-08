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

const trackedToolEventTypes = new Set([
  'tool_requested',
  'tool_approval_requested',
  'tool_approval_resolved',
  'tool_started',
  'tool_result',
]);

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

const createToolCallResponseStream = (toolCall: ToolCall) => {
  const stream = createAssistantMessageEventStream();
  const message = createAssistantMessage([toolCall], 'toolUse');

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

const readJsonl = async (
  readFile: (relativePath: string) => Promise<string>,
  relativePath: string,
): Promise<Array<Record<string, unknown>>> =>
  (await readFile(relativePath))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

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

  const sessionEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getSessionLogRelativePath('cli:test-session'),
  );
  const episodicEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getEpisodicLogRelativePath('cli:test-session'),
  );

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
  assert.ok(
    episodicEntries.some((entry) => entry.type === 'session_started'),
  );
  assert.ok(
    episodicEntries.some((entry) => entry.type === 'message_received'),
  );
  assert.ok(
    episodicEntries.some((entry) => entry.type === 'message_sent'),
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
  assert.match(capturedSystemPrompt, /Built-in tools are execution primitives, not product goals/);
  assert.match(capturedSystemPrompt, /Do not frame yourself as a container-management assistant/);
  assert.match(capturedSystemPrompt, /Container tool rules:/);
  assert.match(capturedSystemPrompt, /containers\/\{name\}\/data/);
  assert.match(capturedSystemPrompt, /Files under files\/ or the workspace root are not mounted automatically/);
  assert.match(capturedSystemPrompt, /mounted files appear under \/workspace inside the container/);
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

  const sessionEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getSessionLogRelativePath('cli:tool-session'),
  );

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

  const sessionEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getSessionLogRelativePath('cli:no-key-session'),
  );

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

  const sessionEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getSessionLogRelativePath('cli:approval-session'),
  );
  const episodicEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getEpisodicLogRelativePath('cli:approval-session'),
  );

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
  assert.ok(
    episodicEntries.some(
      (entry) =>
        entry.type === 'tool_approval_requested' &&
        entry.data &&
        typeof entry.data === 'object' &&
        'toolName' in entry.data &&
        entry.data.toolName === 'write_file',
    ),
  );
  assert.ok(
    episodicEntries.some(
      (entry) =>
        entry.type === 'tool_approval_resolved' &&
        entry.data &&
        typeof entry.data === 'object' &&
        'decision' in entry.data &&
        entry.data.decision === 'approved',
    ),
  );
  const approvalFlow = episodicEntries
    .map((entry) => String(entry.type))
    .filter((type) => trackedToolEventTypes.has(type));
  assert.deepEqual(approvalFlow, [
    'tool_requested',
    'tool_approval_requested',
    'tool_approval_resolved',
    'tool_started',
    'tool_result',
  ]);
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

  const sessionEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getSessionLogRelativePath('cli:deny-session'),
  );
  const episodicEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    runner.getEpisodicLogRelativePath('cli:deny-session'),
  );

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
  assert.ok(
    episodicEntries.some(
      (entry) =>
        entry.type === 'tool_approval_resolved' &&
        entry.data &&
        typeof entry.data === 'object' &&
        'decision' in entry.data &&
        entry.data.decision === 'rejected',
    ),
  );
  const deniedFlow = episodicEntries
    .map((entry) => String(entry.type))
    .filter((type) => trackedToolEventTypes.has(type));
  assert.deepEqual(deniedFlow, [
    'tool_requested',
    'tool_approval_requested',
    'tool_approval_resolved',
    'tool_result',
  ]);
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

  const originalLogPath = runner.getSessionLogRelativePath('cli:persisted-session');
  const indexedSessions = await runner.listSessions({ kind: 'cli' });
  assert.equal(indexedSessions.length, 1);
  assert.equal(indexedSessions[0]?.sessionId, 'cli:persisted-session');

  await workspace.deleteFile('sessions/index.json');

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
  assert.equal(
    restoredRunner.getSessionLogRelativePath('cli:persisted-session'),
    originalLogPath,
  );

  await restoredRunner.postMessage('cli:persisted-session', {
    text: 'continue persistence',
  });
  await restoredRunner.waitForSessionIdle('cli:persisted-session');

  const sessionEntries = await readJsonl(
    (relativePath) => workspace.readFile(relativePath),
    originalLogPath,
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
