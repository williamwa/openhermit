import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBeforeExitLangfuseHandler, createSignalShutdownHandler } from '../src/process-lifecycle.js';

test('createSignalShutdownHandler flushes Langfuse, closes the server, and exits once', async () => {
  const calls: string[] = [];
  let exitCode: number | undefined;
  let closeCount = 0;

  const handler = createSignalShutdownHandler({
    server: {
      close(callback: (error?: Error) => void) {
        closeCount += 1;
        calls.push('close');
        callback();
        return this;
      },
    } as never,
    shutdownLangfuse: async () => {
      calls.push('langfuse');
    },
    exit: (code) => {
      exitCode = code;
      calls.push('exit');
    },
  });

  handler();
  handler();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['langfuse', 'close', 'exit']);
  assert.equal(closeCount, 1);
  assert.equal(exitCode, 0);
});

test('createBeforeExitLangfuseHandler flushes Langfuse without exiting', async () => {
  let flushed = false;

  const handler = createBeforeExitLangfuseHandler(async () => {
    flushed = true;
  });

  handler();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(flushed, true);
});
