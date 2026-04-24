import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionSummary } from '@openhermit/protocol';
import type { AgentLocalClient } from '@openhermit/sdk';
import { parseSseFrames } from '@openhermit/sdk';

import {
  formatSessionList,
  parseChatCliArgs,
  parseSlashCommand,
  selectStartupSession,
  waitForAssistantTurn,
} from '../src/index.js';

test('parseChatCliArgs resolves agent id and session', () => {
  const parsed = parseChatCliArgs(
    ['--agent-id', 'agent-a', '--session', 'cli:123'],
    {},
  );

  assert.deepEqual(parsed, {
    agentId: 'agent-a',
    sessionId: 'cli:123',
  });
});

test('parseChatCliArgs supports --resume', () => {
  const parsed = parseChatCliArgs(['--resume'], {});

  assert.deepEqual(parsed, {
    agentId: 'main',
    resume: true,
  });
});

test('parseChatCliArgs rejects --resume together with --session', () => {
  assert.throws(
    () => parseChatCliArgs(['--resume', '--session', 'cli:123'], {}),
    /Cannot use --resume together with --session/,
  );
});

test('parseChatCliArgs falls back to the main agent id', () => {
  const parsed = parseChatCliArgs([], {});

  assert.equal(parsed.agentId, 'main');
});

test('parseSlashCommand parses session control commands', () => {
  assert.deepEqual(parseSlashCommand('/new'), { type: 'new' });
  assert.deepEqual(parseSlashCommand('/sessions'), { type: 'sessions' });
  assert.deepEqual(parseSlashCommand('/resume cli:123'), {
    type: 'resume',
    sessionId: 'cli:123',
  });
  assert.equal(parseSlashCommand('hello'), null);
});

test('parseSlashCommand validates command usage', () => {
  assert.throws(() => parseSlashCommand('/resume'), /Usage: \/resume <sessionId>/);
  assert.throws(() => parseSlashCommand('/sessions 10'), /Usage: \/sessions/);
});

test('formatSessionList highlights current session and truncates previews', () => {
  const sessions: SessionSummary[] = [
    {
      sessionId: 'cli:current',
      source: {
        kind: 'cli',
        interactive: true,
      },
      createdAt: '2026-03-08T00:00:00.000Z',
      lastActivityAt: '2026-03-08T01:00:00.000Z',
      lastEventId: 7,
      messageCount: 4,
      description: 'Build Telegram bridge retry strategy',
      lastMessagePreview:
        'This is a very long assistant preview that should be trimmed down for compact CLI display.',
      status: 'idle',
    },
    {
      sessionId: 'cli:older',
      source: {
        kind: 'cli',
        interactive: true,
      },
      createdAt: '2026-03-08T00:00:00.000Z',
      lastActivityAt: '2026-03-08T00:30:00.000Z',
      lastEventId: 3,
      messageCount: 2,
      lastMessagePreview: 'Short preview',
      status: 'awaiting_approval',
    },
  ];

  const output = formatSessionList(sessions, 'cli:current');

  assert.match(output, /CLI sessions \(most recent first\):/);
  assert.match(output, /\* cli:current 2026-03-08T01:00:00.000Z messages=4/);
  assert.match(output, /Build Telegram bridge retry strategy/);
  assert.match(output, /  cli:older 2026-03-08T00:30:00.000Z messages=2 Short preview/);
});

test('selectStartupSession resumes latest session when requested', () => {
  const sessions: SessionSummary[] = [
    {
      sessionId: 'cli:latest',
      source: {
        kind: 'cli',
        interactive: true,
      },
      createdAt: '2026-03-08T00:00:00.000Z',
      lastActivityAt: '2026-03-08T01:00:00.000Z',
      lastEventId: 9,
      messageCount: 4,
      description: 'Most recent session',
      status: 'idle',
    },
  ];

  assert.deepEqual(selectStartupSession({ resume: true }, sessions), {
    sessionId: 'cli:latest',
    lastEventId: 9,
    resumed: true,
  });
});

test('selectStartupSession creates a new session when --resume has no history', () => {
  assert.deepEqual(
    selectStartupSession({ resume: true }, [], () => 'cli:new-session'),
    {
      sessionId: 'cli:new-session',
      lastEventId: 0,
      resumed: false,
    },
  );
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
        buildEventsUrl: () => 'http://127.0.0.1:3001/sessions/cli%3Atest/events',
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

test('waitForAssistantTurn prints tool starts and result labels without result bodies', async () => {
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
                'id: 1\nevent: tool_call\ndata: {"tool":"write_file","args":{"path":"files/test.py","content":"print(1)"}}\n\n',
                'id: 3\nevent: tool_result\ndata: {"tool":"write_file","isError":false,"text":"Wrote files/test.py","details":{"path":"files/test.py","bytes":8}}\n\n',
                'id: 4\nevent: text_final\ndata: {"text":"Done."}\n\n',
                'id: 5\nevent: agent_end\ndata: {"sessionId":"cli:test"}\n\n',
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
        buildEventsUrl: () => 'http://127.0.0.1:3001/sessions/cli%3Atest/events',
      } as unknown as AgentLocalClient,
      'token',
      'cli:test',
      0,
    );

    assert.equal(nextEventId, 5);
    assert.match(stdoutChunks.join(''), /\[tool\] write_file/);
    assert.match(stdoutChunks.join(''), /"path":"files\/test.py"/);
    assert.match(stdoutChunks.join(''), /\[tool result\] write_file/);
    assert.doesNotMatch(stdoutChunks.join(''), /"bytes":8/);
    assert.equal(stderrChunks.join(''), '');
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('waitForAssistantTurn throws a cancellation error when aborted mid-turn', async () => {
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;
  const abortController = new AbortController();

  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              [
                'event: ready\ndata: {"sessionId":"cli:test"}\n\n',
                'id: 1\nevent: text_delta\ndata: {"text":"still working"}\n\n',
              ].join(''),
            ),
          );

          setTimeout(() => {
            abortController.abort();
          }, 0);
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
    await assert.rejects(
      () =>
        waitForAssistantTurn(
          {
            buildEventsUrl: () => 'http://127.0.0.1:3001/sessions/cli%3Atest/events',
          } as unknown as AgentLocalClient,
          'token',
          'cli:test',
          0,
          {
            signal: abortController.signal,
          },
        ),
      /Assistant turn cancelled/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
