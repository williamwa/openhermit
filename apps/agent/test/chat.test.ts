import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentLocalClient } from '@cloudmind/sdk';

import {
  parseChatCliArgs,
  parseSseFrames,
  resolveWorkspaceRoot,
  waitForAssistantTurn,
} from '../src/chat.js';

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

test('waitForAssistantTurn keeps streaming after error events until agent_end', async () => {
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'event: ready\ndata: {"sessionId":"cli:test"}\n\n',
                'id: 1\nevent: error\ndata: {"message":"Tool container_run failed: mount invalid"}\n\n',
                'id: 2\nevent: text_delta\ndata: {"text":"Recovered and completed"}\n\n',
                'id: 3\nevent: text_final\ndata: {"text":"Recovered and completed"}\n\n',
                'id: 4\nevent: agent_end\ndata: {"sessionId":"cli:test"}\n\n',
              ].join(''),
            ),
          );
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    );

  try {
    const nextEventId = await waitForAssistantTurn(
      {
        buildEventsUrl: () => 'http://127.0.0.1:3001/events?sessionId=cli%3Atest',
      } as unknown as AgentLocalClient,
      'token',
      'cli:test',
      0,
    );

    assert.equal(nextEventId, 4);
    assert.match(stderrChunks.join(''), /Tool container_run failed: mount invalid/);
    assert.match(stdoutChunks.join(''), /Recovered and completed/);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('waitForAssistantTurn prints tool calls and tool results for debugging', async () => {
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'event: ready\ndata: {"sessionId":"cli:test"}\n\n',
                'id: 1\nevent: tool_start\ndata: {"tool":"write_file","args":{"path":"files/test.py","content":"print(1)"}}\n\n',
                'id: 2\nevent: tool_result\ndata: {"tool":"write_file","isError":false,"text":"Wrote files/test.py","details":{"path":"files/test.py","bytes":8}}\n\n',
                'id: 3\nevent: text_final\ndata: {"text":"Done."}\n\n',
                'id: 4\nevent: agent_end\ndata: {"sessionId":"cli:test"}\n\n',
              ].join(''),
            ),
          );
          controller.close();
        },
      }),
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
        },
      },
    );

  try {
    const nextEventId = await waitForAssistantTurn(
      {
        buildEventsUrl: () => 'http://127.0.0.1:3001/events?sessionId=cli%3Atest',
      } as unknown as AgentLocalClient,
      'token',
      'cli:test',
      0,
    );

    assert.equal(nextEventId, 4);
    assert.match(stdoutChunks.join(''), /\[tool\] write_file/);
    assert.match(stdoutChunks.join(''), /"path":"files\/test.py"/);
    assert.match(stdoutChunks.join(''), /\[tool result\] write_file/);
    assert.match(stdoutChunks.join(''), /"bytes":8/);
    assert.equal(stderrChunks.join(''), '');
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});
