import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError } from '@openhermit/shared';

import { InMemoryAgentRuntime } from '../src/runtime.js';

test('InMemoryAgentRuntime merges session metadata when reopening a session', async () => {
  const runtime = new InMemoryAgentRuntime();

  await runtime.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
    metadata: {
      sourceMessageId: '1',
    },
  });

  const reopened = await runtime.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: false,
    },
    metadata: {
      turn: 2,
    },
  });

  assert.equal(reopened.spec.source.interactive, false);
  assert.deepEqual(reopened.spec.metadata, {
    sourceMessageId: '1',
    turn: 2,
  });
});

test('InMemoryAgentRuntime publishes a scaffold response for posted messages', async () => {
  const runtime = new InMemoryAgentRuntime();

  runtime.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });

  const result = await runtime.postMessage('cli:test-session', {
    messageId: 'msg-1',
    text: 'hello',
  });
  const backlog = runtime.events.getBacklog('cli:test-session');

  assert.deepEqual(result, {
    sessionId: 'cli:test-session',
    messageId: 'msg-1',
  });
  assert.equal(backlog.length, 2);
  assert.deepEqual(backlog[0]?.event, {
    type: 'text_final',
    sessionId: 'cli:test-session',
    text: 'OpenHermit agent scaffold received a cli message: hello',
  });
  assert.deepEqual(backlog[1]?.event, {
    type: 'agent_end',
    sessionId: 'cli:test-session',
  });
});

test('InMemoryAgentRuntime rejects messages for unknown sessions', async () => {
  const runtime = new InMemoryAgentRuntime();

  await assert.rejects(
    () => runtime.postMessage('missing-session', { text: 'hello' }),
    NotFoundError,
  );
});

test('InMemoryAgentRuntime lists sessions by last activity and applies filters', async () => {
  const runtime = new InMemoryAgentRuntime();

  await runtime.openSession({
    sessionId: 'im:telegram-1',
    source: {
      kind: 'im',
      platform: 'telegram',
      interactive: true,
    },
  });

  await runtime.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  await runtime.postMessage('cli:test-session', {
    text: 'hello list',
  });

  const cliSessions = await runtime.listSessions({ kind: 'cli' });
  assert.equal(cliSessions.length, 1);
  assert.deepEqual(cliSessions[0], {
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
    createdAt: cliSessions[0]?.createdAt,
    lastActivityAt: cliSessions[0]?.lastActivityAt,
    lastEventId: runtime.events.getBacklog('cli:test-session').at(-1)?.id ?? 0,
    messageCount: 2,
    description: 'hello list',
    lastMessagePreview: 'OpenHermit agent scaffold received a cli message: hello list',
    status: 'idle',
  });

  const telegramSessions = await runtime.listSessions({ platform: 'telegram' });
  assert.equal(telegramSessions.length, 1);
  assert.equal(telegramSessions[0]?.sessionId, 'im:telegram-1');

  const limitedSessions = await runtime.listSessions({ limit: 1 });
  assert.equal(limitedSessions.length, 1);
  assert.equal(limitedSessions[0]?.sessionId, 'cli:test-session');
});
