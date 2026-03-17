import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { createLangfuseClientFromEnv, loadEnvironmentFile } from '../src/langfuse.js';
import { createTempDir } from './helpers.js';

test('loadEnvironmentFile reads .env values without overriding existing env', async (t) => {
  const tempDir = await createTempDir(t, 'openhermit-langfuse-env-');
  const envPath = path.join(tempDir, '.env');
  const originalSecret = process.env.LANGFUSE_SECRET_KEY;
  const originalPublic = process.env.LANGFUSE_PUBLIC_KEY;
  const originalBaseUrl = process.env.LANGFUSE_BASE_URL;

  process.env.LANGFUSE_SECRET_KEY = 'existing-secret';
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_BASE_URL;

  t.after(() => {
    if (originalSecret === undefined) {
      delete process.env.LANGFUSE_SECRET_KEY;
    } else {
      process.env.LANGFUSE_SECRET_KEY = originalSecret;
    }

    if (originalPublic === undefined) {
      delete process.env.LANGFUSE_PUBLIC_KEY;
    } else {
      process.env.LANGFUSE_PUBLIC_KEY = originalPublic;
    }

    if (originalBaseUrl === undefined) {
      delete process.env.LANGFUSE_BASE_URL;
    } else {
      process.env.LANGFUSE_BASE_URL = originalBaseUrl;
    }
  });

  await fs.writeFile(
    envPath,
    [
      'LANGFUSE_SECRET_KEY=from-file-secret',
      'LANGFUSE_PUBLIC_KEY="from-file-public"',
      'LANGFUSE_BASE_URL=https://langfuse.example.com',
    ].join('\n'),
    'utf8',
  );

  const loaded = await loadEnvironmentFile(envPath);

  assert.equal(loaded, 2);
  assert.equal(process.env.LANGFUSE_SECRET_KEY, 'existing-secret');
  assert.equal(process.env.LANGFUSE_PUBLIC_KEY, 'from-file-public');
  assert.equal(process.env.LANGFUSE_BASE_URL, 'https://langfuse.example.com');
});

test('createLangfuseClientFromEnv requires both Langfuse keys', () => {
  const logs: string[] = [];
  const incomplete = createLangfuseClientFromEnv({
    env: {
      LANGFUSE_PUBLIC_KEY: 'pk-test',
    },
    logger: (message) => {
      logs.push(message);
    },
  });

  assert.equal(incomplete, undefined);
  assert.match(logs[0] ?? '', /Langfuse disabled/);

  const client = createLangfuseClientFromEnv({
    env: {
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test',
      LANGFUSE_BASE_URL: 'https://langfuse.example.com',
    },
  });

  assert.ok(client);
});
