import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentLocalRoutes } from '@openhermit/protocol';

import { createAgentApp } from '../src/app.js';
import { InMemoryAgentRuntime } from '../src/runtime.js';

const bearer = 'test-token';

const authHeaders = {
  authorization: `Bearer ${bearer}`,
  'content-type': 'application/json',
};

const readSseChunk = async (
  response: Response,
  abortController: AbortController,
): Promise<string> => {
  const reader = response.body?.getReader();
  assert.ok(reader, 'expected SSE response body');

  let collected = '';

  try {
    for (let index = 0; index < 3; index += 1) {
      const result = await reader.read();

      if (result.done) {
        break;
      }

      collected += new TextDecoder().decode(result.value);

      if (
        collected.includes('event: text_final') &&
        collected.includes('event: agent_end') &&
        collected.includes('event: ready')
      ) {
        break;
      }
    }
  } finally {
    abortController.abort();
    await reader.cancel().catch(() => undefined);
  }

  return collected;
};

test('createAgentApp exposes an unauthenticated health endpoint', async () => {
  const app = createAgentApp(new InMemoryAgentRuntime(), { apiToken: bearer });
  const response = await app.request(agentLocalRoutes.health);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    transport: 'http+sse',
  });
});

test('createAgentApp rejects protected routes without a bearer token', async () => {
  const app = createAgentApp(new InMemoryAgentRuntime(), { apiToken: bearer });
  const response = await app.request(agentLocalRoutes.sessions, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'cli:test-session',
      source: {
        kind: 'cli',
        interactive: true,
      },
    }),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'unauthorized',
      message: 'Invalid or missing bearer token.',
    },
  });
});

test('createAgentApp opens a session, accepts a message, and streams the backlog', async () => {
  const runtime = new InMemoryAgentRuntime();
  const app = createAgentApp(runtime, { apiToken: bearer });

  const openSessionResponse = await app.request(agentLocalRoutes.sessions, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      sessionId: 'cli:test-session',
      source: {
        kind: 'cli',
        interactive: true,
      },
    }),
  });

  assert.equal(openSessionResponse.status, 200);
  assert.deepEqual(await openSessionResponse.json(), {
    sessionId: 'cli:test-session',
  });

  const postMessageResponse = await app.request(
    agentLocalRoutes.sessionMessages('cli:test-session'),
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        messageId: 'msg-1',
        text: 'hello from test',
      }),
    },
  );

  assert.equal(postMessageResponse.status, 200);
  assert.deepEqual(await postMessageResponse.json(), {
    sessionId: 'cli:test-session',
    messageId: 'msg-1',
  });

  const eventsAbortController = new AbortController();
  const eventsResponse = await app.request(
    agentLocalRoutes.eventsUrl('cli:test-session'),
    {
      headers: {
        authorization: `Bearer ${bearer}`,
      },
      signal: eventsAbortController.signal,
    },
  );

  assert.equal(eventsResponse.status, 200);
  assert.match(
    eventsResponse.headers.get('content-type') ?? '',
    /^text\/event-stream/i,
  );

  const sseText = await readSseChunk(eventsResponse, eventsAbortController);

  assert.match(sseText, /event: text_final/);
  assert.match(sseText, /event: agent_end/);
  assert.match(
    sseText,
    /OpenHermit agent scaffold received a cli message: hello from test/,
  );
  assert.match(sseText, /event: ready/);
});

test('createAgentApp returns session messages in reverse chronological order', async () => {
  const runtime = new InMemoryAgentRuntime();
  const app = createAgentApp(runtime, { apiToken: bearer });

  await runtime.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });
  await runtime.postMessage('cli:test-session', {
    messageId: 'msg-1',
    text: 'hello history',
  });

  const response = await app.request(
    agentLocalRoutes.sessionMessages('cli:test-session'),
    {
      method: 'GET',
      headers: {
        authorization: `Bearer ${bearer}`,
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    {
      ts: runtime.getSession('cli:test-session')?.history[1]?.ts,
      role: 'assistant',
      content: 'OpenHermit agent scaffold received a cli message: hello history',
    },
    {
      ts: runtime.getSession('cli:test-session')?.history[0]?.ts,
      role: 'user',
      content: 'hello history',
      messageId: 'msg-1',
    },
  ]);
});

test('createAgentApp exposes the session checkpoint endpoint', async () => {
  const runtime = new InMemoryAgentRuntime();
  const app = createAgentApp(runtime, { apiToken: bearer });

  await runtime.openSession({
    sessionId: 'cli:test-session',
    source: {
      kind: 'cli',
      interactive: true,
    },
  });

  const response = await app.request(
    agentLocalRoutes.sessionCheckpoint('cli:test-session'),
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ reason: 'manual' }),
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    checkpointed: false,
  });
});

test('createAgentApp requires a sessionId in the session events route', async () => {
  const app = createAgentApp(new InMemoryAgentRuntime(), { apiToken: bearer });
  const response = await app.request('/sessions//events', {
    headers: {
      authorization: `Bearer ${bearer}`,
    },
  });

  assert.equal(response.status, 404);
});

test('createAgentApp lists sessions with filters and sorting', async () => {
  const runtime = new InMemoryAgentRuntime();
  const app = createAgentApp(runtime, { apiToken: bearer });

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
  await runtime.postMessage('cli:test-session', {
    text: 'hello list',
  });

  const response = await app.request('/sessions?kind=cli&interactive=true&limit=1', {
    headers: {
      authorization: `Bearer ${bearer}`,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [
    {
      sessionId: 'cli:test-session',
      source: {
        kind: 'cli',
        interactive: true,
      },
      createdAt: runtime.getSession('cli:test-session')?.createdAt,
      lastActivityAt: runtime.getSession('cli:test-session')?.updatedAt,
      lastEventId: runtime.events.getBacklog('cli:test-session').at(-1)?.id ?? 0,
      messageCount: 2,
      description: 'hello list',
      lastMessagePreview: 'OpenHermit agent scaffold received a cli message: hello list',
      status: 'idle',
    },
  ]);
});

test('createAgentApp validates session list query parameters', async () => {
  const app = createAgentApp(new InMemoryAgentRuntime(), { apiToken: bearer });
  const response = await app.request('/sessions?interactive=maybe&limit=0', {
    headers: {
      authorization: `Bearer ${bearer}`,
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'validation_error',
      message: 'Invalid boolean query value: maybe',
    },
  });
});
