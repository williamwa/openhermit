import assert from 'node:assert/strict';
import test from 'node:test';

import { ProcessTimeoutError, runProcess } from '../src/index.ts';

test('runProcess captures stdout, stderr, and exit code', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    "console.log('hello'); console.error('warn'); process.exit(3);",
  ]);

  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /hello/);
  assert.match(result.stderr, /warn/);
  assert.ok(result.durationMs > 0);
});

test('runProcess rejects with ProcessTimeoutError when the timeout is exceeded', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 2000);'], { timeoutMs: 50 }),
    (error: unknown) => {
      assert.ok(error instanceof ProcessTimeoutError);
      assert.equal(error.timeoutMs, 50);
      assert.equal(error.command, process.execPath);
      assert.ok(error.durationMs > 0);
      return true;
    },
  );
});
