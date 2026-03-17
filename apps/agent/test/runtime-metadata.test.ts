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
    /Refusing to start: runtime metadata already exists/,
  );
});
