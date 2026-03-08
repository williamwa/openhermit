import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError } from '@cloudmind/shared';

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
  assert.equal(backlog.length, 1);
  assert.deepEqual(backlog[0]?.event, {
    type: 'text_final',
    sessionId: 'cli:test-session',
    text: 'CloudMind agent scaffold received a cli message: hello',
  });
});

test('InMemoryAgentRuntime rejects messages for unknown sessions', async () => {
  const runtime = new InMemoryAgentRuntime();

  await assert.rejects(
    () => runtime.postMessage('missing-session', { text: 'hello' }),
    NotFoundError,
  );
});
