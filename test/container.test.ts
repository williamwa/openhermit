import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { TestContext } from 'node:test';

import {
  ContainerRunTimeoutError,
  ProcessTimeoutError,
  createContainerRunPlan,
  initWorkspace,
  runEphemeralContainer,
} from '../src/index.ts';

async function createSandbox(t: TestContext): Promise<string> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'cloudmind-container-test-'));
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }));
  return sandboxRoot;
}

test('createContainerRunPlan builds docker arguments with v0.1 safety defaults', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);
  await mkdir(join(workspaceRoot, 'files', 'app'), { recursive: true });

  const plan = await createContainerRunPlan(workspaceRoot, {
    image: 'python:3.12-slim',
    command: 'python -V',
    workdir: 'app',
    env: {
      APP_ENV: 'test',
    },
  });

  assert.ok(plan.containerName.startsWith('cloudmind-run-'));
  assert.equal(plan.timeoutMs, 120_000);
  assert.equal(plan.containerWorkdir, '/workspace/app');
  assert.equal(plan.hostFilesPath, await realpath(join(workspaceRoot, 'files')));

  assert.deepEqual(plan.args, [
    'run',
    '--rm',
    '--name',
    plan.containerName,
    '--memory',
    '512m',
    '--cpu-shares',
    '512',
    '--network',
    'none',
    '--volume',
    `${await realpath(join(workspaceRoot, 'files'))}:/workspace`,
    '--workdir',
    '/workspace/app',
    '--env',
    'APP_ENV=test',
    'python:3.12-slim',
    'sh',
    '-lc',
    'python -V',
  ]);
});

test('createContainerRunPlan rejects images outside the allowlist', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);

  await assert.rejects(
    createContainerRunPlan(workspaceRoot, {
      image: 'alpine:3.20',
      command: 'echo hello',
    }),
    /allowlist/,
  );
});

test('createContainerRunPlan rejects workdirs that escape files/', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);

  await assert.rejects(
    createContainerRunPlan(workspaceRoot, {
      image: 'python:3.12-slim',
      command: 'pwd',
      workdir: '../memory',
    }),
    /escapes files/,
  );
});

test('runEphemeralContainer delegates to the process runner and returns execution metadata', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);

  let capturedCommand = '';
  let capturedArgs: string[] = [];
  let capturedTimeout = 0;

  const result = await runEphemeralContainer(
    workspaceRoot,
    {
      image: 'python:3.12-slim',
      command: 'python -V',
    },
    {
      runProcess: async (command, args, options) => {
        capturedCommand = command;
        capturedArgs = args;
        capturedTimeout = options?.timeoutMs ?? 0;

        return {
          stdout: 'Python 3.12.0\n',
          stderr: '',
          exitCode: 0,
          signal: null,
          durationMs: 12,
        };
      },
    },
  );

  assert.equal(capturedCommand, 'docker');
  assert.ok(capturedArgs.includes('python:3.12-slim'));
  assert.equal(capturedTimeout, 120_000);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Python 3.12/);
  assert.equal(result.image, 'python:3.12-slim');
  assert.equal(result.command, 'python -V');
  assert.ok(result.containerName.startsWith('cloudmind-run-'));
});

test('runEphemeralContainer wraps process timeouts with container metadata', async (t) => {
  const sandboxRoot = await createSandbox(t);
  const workspaceRoot = join(sandboxRoot, 'workspace');

  await initWorkspace('agent-123', workspaceRoot);

  await assert.rejects(
    runEphemeralContainer(
      workspaceRoot,
      {
        image: 'python:3.12-slim',
        command: 'sleep 10',
      },
      {
        runProcess: async () => {
          throw new ProcessTimeoutError({
            command: 'docker',
            args: ['run'],
            timeoutMs: 250,
            stdout: '',
            stderr: '',
            signal: 'SIGTERM',
            durationMs: 250,
          });
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ContainerRunTimeoutError);
      assert.equal(error.timeoutMs, 250);
      assert.equal(error.plan.image, 'python:3.12-slim');
      assert.equal(error.plan.command, 'sleep 10');
      return true;
    },
  );
});
