import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assertRuntimeMetadataAbsent } from '../src/runtime-metadata.js';

test('assertRuntimeMetadataAbsent succeeds when runtime metadata is missing', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openhermit-runtime-meta-'));
  const runtimeFilePath = path.join(tempDir, 'runtime.json');

  await assert.doesNotReject(() => assertRuntimeMetadataAbsent(runtimeFilePath));
});

test('assertRuntimeMetadataAbsent rejects when runtime metadata already exists', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openhermit-runtime-meta-'));
  const runtimeFilePath = path.join(tempDir, 'runtime.json');
  await writeFile(runtimeFilePath, '{}\n', 'utf8');

  await assert.rejects(
    () => assertRuntimeMetadataAbsent(runtimeFilePath),
    /runtime metadata already exists.*could not be parsed/i,
  );
});

test('assertRuntimeMetadataAbsent reports a running agent when the recorded port responds', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openhermit-runtime-meta-'));
  const runtimeFilePath = path.join(tempDir, 'runtime.json');
  await writeFile(
    runtimeFilePath,
    JSON.stringify({ http_api: { port: 4310, token: 'test' } }),
    'utf8',
  );

  await assert.rejects(
    () =>
      assertRuntimeMetadataAbsent(runtimeFilePath, {
        probe: async () => true,
      }),
    /another agent appears to be running at http:\/\/127\.0\.0\.1:4310/i,
  );
});

test('assertRuntimeMetadataAbsent reports stale runtime metadata when the recorded port is dead', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openhermit-runtime-meta-'));
  const runtimeFilePath = path.join(tempDir, 'runtime.json');
  await writeFile(
    runtimeFilePath,
    JSON.stringify({ http_api: { port: 4310, token: 'test' } }),
    'utf8',
  );

  await assert.rejects(
    () =>
      assertRuntimeMetadataAbsent(runtimeFilePath, {
        probe: async () => false,
      }),
    /stale runtime metadata exists .*remove that runtime\.json and retry/i,
  );
});
