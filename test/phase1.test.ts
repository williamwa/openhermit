import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { TestContext } from 'node:test';

import {
  appendJsonl,
  describeResolvedSecrets,
  initSecrets,
  initSecurity,
  initWorkspace,
  listSecretNames,
  loadSecrets,
  loadSecurity,
  readConfig,
  requiresApproval,
  resolveReadPath,
  resolveSecrets,
  resolveWritePath,
} from '../src/index.ts';

async function createSandbox(t: TestContext): Promise<string> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'cloudmind-test-'));
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }));
  return sandboxRoot;
}

test('initWorkspace scaffolds the expected Phase 1 files', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);
  const config = await readConfig(workspaceRoot);

  assert.equal(config.agent_id, 'agent-123');
  assert.match(await readFile(join(workspaceRoot, 'memory', 'working.md'), 'utf8'), /Working Memory/);
  assert.match(await readFile(join(workspaceRoot, 'identity', 'AGENTS.md'), 'utf8'), /workspace/);
});

test('resolveReadPath rejects traversal and null bytes', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);

  await assert.rejects(resolveReadPath(workspaceRoot, '../outside.txt'), /escapes the workspace/);
  await assert.rejects(resolveReadPath(workspaceRoot, 'files/\0bad.txt'), /Null bytes/);
});

test('resolveReadPath rejects symlink escapes', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');
  const outsidePath = join(sandboxRoot, 'outside.txt');
  const linkedPath = join(workspaceRoot, 'files', 'escape.txt');

  await initWorkspace('agent-123', workspaceRoot);
  await writeFile(outsidePath, 'outside', 'utf8');
  await symlink(outsidePath, linkedPath);

  await assert.rejects(
    resolveReadPath(workspaceRoot, 'files/escape.txt'),
    /after symlink resolution/,
  );
});

test('resolveWritePath enforces writable roots and catches symlink escapes', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');
  const linkedDirectory = join(workspaceRoot, 'files', 'linked');

  await initWorkspace('agent-123', workspaceRoot);

  await assert.doesNotReject(resolveWritePath(workspaceRoot, 'files/script.py'));
  await assert.doesNotReject(resolveWritePath(workspaceRoot, 'memory/working.md'));
  await assert.doesNotReject(resolveWritePath(workspaceRoot, 'memory/notes/facts.md'));
  await assert.rejects(resolveWritePath(workspaceRoot, 'config.json'), /Writes are not allowed/);

  await rm(linkedDirectory, { recursive: true, force: true });
  await symlink(sandboxRoot, linkedDirectory);

  await assert.rejects(
    resolveWritePath(workspaceRoot, 'files/linked/escape.txt'),
    /after symlink resolution/,
  );
});

test('security and secrets stay outside the workspace and preserve existing values', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const cloudmindHome = join(sandboxRoot, 'cloudmind-home');

  const securityPath = await initSecurity('agent-123', { cloudmindHome });
  const secretsPath = await initSecrets('agent-123', { cloudmindHome });

  await writeFile(
    securityPath,
    JSON.stringify(
      {
        autonomy_level: 'readonly',
        require_approval_for: ['container_run', 'write_file'],
      },
      null,
      2,
    ),
  );
  await writeFile(
    secretsPath,
    JSON.stringify(
      {
        API_KEY: 'top-secret',
        DB_PASSWORD: 'also-secret',
      },
      null,
      2,
    ),
  );

  await initSecurity('agent-123', { cloudmindHome });
  await initSecrets('agent-123', { cloudmindHome });

  const security = await loadSecurity('agent-123', { cloudmindHome });
  const secrets = await loadSecrets('agent-123', { cloudmindHome });

  assert.equal(security.autonomy_level, 'readonly');
  assert.equal(requiresApproval(security, 'write_file'), true);
  assert.deepEqual(listSecretNames(secrets), ['API_KEY', 'DB_PASSWORD']);
  assert.deepEqual(resolveSecrets(secrets, ['API_KEY']), { API_KEY: 'top-secret' });
  assert.equal(describeResolvedSecrets(['API_KEY']), 'env vars set: API_KEY');
  assert.equal(describeResolvedSecrets(['API_KEY']).includes('top-secret'), false);
});

test('appendJsonl serializes concurrent writes', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const logPath = join(sandboxRoot, 'episodic.jsonl');

  await Promise.all(
    Array.from({ length: 25 }, (_, index) => appendJsonl(logPath, { index })),
  );

  const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 25);

  const indexes = lines.map((line) => JSON.parse(line).index);
  assert.equal(new Set(indexes).size, 25);
});
