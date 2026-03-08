import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseChatCliArgs, parseSseFrames, resolveWorkspaceRoot } from '../src/chat.js';

test('resolveWorkspaceRoot uses explicit workspace when provided', () => {
  assert.equal(
    resolveWorkspaceRoot('/repo', 'agent-dev', './custom-agent'),
    '/repo/custom-agent',
  );
});

test('parseChatCliArgs resolves agent id, workspace, and session', () => {
  const parsed = parseChatCliArgs(
    ['--agent-id', 'agent-a', '--workspace', './runtime/agent-a', '--session', 'cli:123'],
    '/repo',
    {},
  );

  assert.deepEqual(parsed, {
    agentId: 'agent-a',
    workspaceRoot: '/repo/runtime/agent-a',
    sessionId: 'cli:123',
  });
});

test('parseChatCliArgs falls back to default dev workspace', () => {
  const parsed = parseChatCliArgs([], '/repo', {});

  assert.equal(parsed.agentId, 'agent-dev');
  assert.equal(parsed.workspaceRoot, '/repo/.cloudmind-dev/agent-dev');
});

test('parseSseFrames parses multiple frames and preserves incomplete remainder', () => {
  const parsed = parseSseFrames(
    [
      'id: 1',
      'event: text_delta',
      'data: {"text":"hello"}',
      '',
      'event: ping',
      'data: {"sessionId":"s1"}',
      '',
      'id: 2',
      'event: text_final',
      'data: {"text":"done"}',
    ].join('\n'),
  );

  assert.deepEqual(parsed.frames, [
    {
      id: 1,
      event: 'text_delta',
      data: '{"text":"hello"}',
    },
    {
      event: 'ping',
      data: '{"sessionId":"s1"}',
    },
  ]);
  assert.equal(
    parsed.remainder,
    ['id: 2', 'event: text_final', 'data: {"text":"done"}'].join('\n'),
  );
});
