import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  createBeforeExitLangfuseHandler,
  createExitRuntimeFileCleanupHandler,
  createSignalShutdownHandler,
} from '../src/process-lifecycle.js';

test('createSignalShutdownHandler flushes Langfuse, closes the server, cleans up, and exits once', async () => {
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
    cleanup: async () => {
      calls.push('cleanup');
    },
    exit: (code) => {
      exitCode = code;
      calls.push('exit');
    },
  });

  handler();
  handler();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, ['langfuse', 'close', 'cleanup', 'exit']);
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

test('createExitRuntimeFileCleanupHandler removes runtime metadata file', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openhermit-runtime-cleanup-'));
  const runtimeFilePath = path.join(tempDir, 'runtime.json');
  await writeFile(runtimeFilePath, '{}\n', 'utf8');

  const cleanup = createExitRuntimeFileCleanupHandler(runtimeFilePath);
  cleanup();

  const exists = await access(runtimeFilePath).then(() => true).catch(() => false);

  assert.equal(exists, false);
});
