import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAgentCliArgs } from '../src/args.js';

test('parseAgentCliArgs supports agent id and port overrides', () => {
  const parsed = parseAgentCliArgs(
    ['--agent-id', 'agent-a', '--port', '3100'],
    '/repo',
    {},
  );

  assert.deepEqual(parsed, {
    agentId: 'agent-a',
    port: 3100,
  });
});

test('parseAgentCliArgs falls back to env and defaults', () => {
  const parsed = parseAgentCliArgs([], '/repo', {
    OPENHERMIT_AGENT_ID: 'agent-env',
  });

  assert.deepEqual(parsed, {
    agentId: 'agent-env',
  });
});
