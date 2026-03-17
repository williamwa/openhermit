import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentLocalClient } from '../src/index.js';

test('AgentLocalClient surfaces network failures with a helpful local-agent message', async () => {
  const client = new AgentLocalClient({
    baseUrl: 'http://127.0.0.1:61092',
    token: 'test-token',
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  });

  await assert.rejects(
    () => client.listSessions(),
    /Agent local API is unavailable at http:\/\/127\.0\.0\.1:61092\/sessions/,
  );
  await assert.rejects(
    () => client.listSessions(),
    /npm run dev:agent/,
  );
});
