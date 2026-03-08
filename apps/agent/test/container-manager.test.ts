import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  OpenHermitError,
  NotFoundError,
  ValidationError,
} from '@openhermit/shared';

import {
  type DockerCommandResult,
  type DockerRunner,
  DockerContainerManager,
} from '../src/core/index.js';
import { createWorkspaceFixture } from './helpers.js';

class FakeDockerRunner implements DockerRunner {
  readonly calls: string[][] = [];

  constructor(private readonly results: DockerCommandResult[]) {}

  async run(args: string[]): Promise<DockerCommandResult> {
    this.calls.push(args);

    const nextResult = this.results.shift();

    if (!nextResult) {
      throw new Error(`Unexpected docker call: ${args.join(' ')}`);
    }

    return nextResult;
  }
}

const okResult = (
  overrides: Partial<DockerCommandResult> = {},
): DockerCommandResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  ...overrides,
});

test('DockerContainerManager rejects mounts outside containers/{name}/data', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () =>
      manager.runEphemeral({
        image: 'alpine:3.20',
        command: 'echo hello',
        mount: 'files/not-allowed',
      }),
    ValidationError,
  );

  assert.equal(runner.calls.length, 0);
});

test('DockerContainerManager rejects mount traversal outside containers/{name}/data', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () =>
      manager.runEphemeral({
        image: 'alpine:3.20',
        command: 'echo hello',
        mount: 'containers/demo/data/../escape',
      }),
    ValidationError,
  );

  await assert.rejects(
    () =>
      manager.startService({
        name: 'redis-cache',
        image: 'redis:7',
        mount: 'containers/redis-cache/data/../../oops',
      }),
    ValidationError,
  );

  assert.equal(runner.calls.length, 0);
});

test('DockerContainerManager runEphemeral records the container and parses structured output', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({
      stdout: [
        'starting',
        '---OPENHERMIT_OUTPUT_START---',
        '{"ok":true,"count":2}',
        '---OPENHERMIT_OUTPUT_END---',
      ].join('\n'),
      durationMs: 17,
    }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  const result = await manager.runEphemeral({
    image: 'node:20-alpine',
    command: 'node -e "console.log(1)"',
    description: 'Run a one-off node task',
    env: {
      DEMO: '1',
    },
    workdir: '/workspace/app',
  });

  assert.equal(runner.calls.length, 1);
  const dockerArgs = runner.calls[0] ?? [];
  const mountIndex = dockerArgs.indexOf('-v');
  const envIndex = dockerArgs.indexOf('-e');

  assert.equal(dockerArgs[0], 'run');
  assert.equal(dockerArgs[1], '--rm');
  assert.ok(mountIndex >= 0);
  assert.match(dockerArgs[mountIndex + 1] ?? '', /\/containers\/run-.*\/data:\/workspace$/);
  assert.equal(envIndex >= 0, true);
  assert.equal(dockerArgs[envIndex + 1], 'DEMO=1');
  assert.deepEqual(dockerArgs.slice(-4), [
    'node:20-alpine',
    'sh',
    '-lc',
    'node -e "console.log(1)"',
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.durationMs, 17);
  assert.deepEqual(result.parsedOutput, {
    ok: true,
    count: 2,
  });
  assert.equal(result.container.type, 'ephemeral');
  assert.equal(result.container.status, 'removed');
  assert.equal(result.container.description, 'Run a one-off node task');
  assert.equal(result.container.command, 'node -e "console.log(1)"');
  assert.equal(result.container.exit_code, 0);
  assert.match(result.container.mount ?? '', /^containers\/run-.*\/data$/);

  const registryEntries = await manager.registry.readAll();
  assert.equal(registryEntries.length, 1);
  assert.equal(registryEntries[0]?.status, 'removed');
  assert.equal(registryEntries[0]?.description, 'Run a one-off node task');
});

test('DockerContainerManager startService and stopService persist service lifecycle', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({ stdout: 'container-123\n' }),
    okResult({}),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  const started = await manager.startService({
    name: 'redis-cache',
    image: 'redis:7',
    description: 'Cache service',
    ports: {
      '6379': 6379,
    },
    env: {
      ALLOW_EMPTY_PASSWORD: 'yes',
    },
    network: 'openhermit',
  });

  assert.equal(started.name, 'redis-cache');
  assert.equal(started.status, 'running');
  assert.equal(started.runtime_container_id, 'container-123');
  assert.equal(started.description, 'Cache service');
  assert.deepEqual(started.ports, {
    '6379': 6379,
  });
  assert.deepEqual(runner.calls[0], [
    'run',
    '-d',
    '--name',
    'redis-cache',
    '-v',
    `${workspace.root}/containers/redis-cache/data:/data`,
    '-p',
    '6379:6379',
    '-e',
    'ALLOW_EMPTY_PASSWORD=yes',
    '--network',
    'openhermit',
    'redis:7',
  ]);

  const stopped = await manager.stopService('redis-cache');

  assert.deepEqual(runner.calls[1], ['rm', '-f', 'redis-cache']);
  assert.equal(stopped.status, 'removed');
  assert.ok(stopped.removed);

  const registryEntries = await manager.registry.readAll();
  assert.equal(registryEntries.length, 1);
  assert.equal(registryEntries[0]?.status, 'removed');
});

test('DockerContainerManager tolerates stopping a missing live container when registry exists', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({ stdout: 'container-123\n' }),
    okResult({
      exitCode: 1,
      stderr: 'Error response from daemon: No such container: redis-cache',
    }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await manager.startService({
    name: 'redis-cache',
    image: 'redis:7',
  });

  const stopped = await manager.stopService('redis-cache');

  assert.equal(stopped.status, 'removed');
});

test('DockerContainerManager rejects stopping an unregistered service container', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () => manager.stopService('foreign-container'),
    NotFoundError,
  );

  assert.equal(runner.calls.length, 0);
});

test('DockerContainerManager rejects exec for unregistered or removed service containers', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({ stdout: 'container-123\n' }),
    okResult({}),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () => manager.execInService('foreign-container', 'echo hello'),
    NotFoundError,
  );

  await manager.startService({
    name: 'redis-cache',
    image: 'redis:7',
  });
  await manager.stopService('redis-cache');

  await assert.rejects(
    () => manager.execInService('redis-cache', 'echo hello'),
    ValidationError,
  );

  assert.equal(runner.calls.length, 2);
});

test('DockerContainerManager listAll merges live docker status into registry entries', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({ stdout: 'container-123\n' }),
    okResult({
      stdout: JSON.stringify({
        ID: 'container-live',
        Names: 'redis-cache',
        Image: 'redis:7',
        Status: 'Up 15 seconds',
      }),
    }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await manager.startService({
    name: 'redis-cache',
    image: 'redis:7',
  });

  const containers = await manager.listAll();

  assert.equal(containers.length, 1);
  assert.equal(containers[0]?.status, 'running');
  assert.equal(containers[0]?.runtime_container_id, 'container-live');
  assert.equal(containers[0]?.live_status_text, 'Up 15 seconds');
});

test('DockerContainerManager surfaces docker failures from startService', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);
  const runner = new FakeDockerRunner([
    okResult({
      exitCode: 125,
      stderr: 'port already in use',
    }),
  ]);
  const manager = new DockerContainerManager(workspace, { runner });

  await assert.rejects(
    () =>
      manager.startService({
        name: 'redis-cache',
        image: 'redis:7',
      }),
    (error: unknown) => {
      assert.ok(error instanceof OpenHermitError);
      assert.equal(error.code, 'docker_run_failed');
      assert.match(error.message, /port already in use/);
      return true;
    },
  );
});
