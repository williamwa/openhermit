import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ValidationError } from '@cloudmind/shared';

import {
  type DockerCommandResult,
  type DockerRunner,
  DockerContainerManager,
} from '../src/core/index.js';
import { createBuiltInTools } from '../src/tools.js';
import { createSecurityFixture } from './helpers.js';

// ---------------------------------------------------------------------------
// Shared test infrastructure
// ---------------------------------------------------------------------------

class FakeDockerRunner implements DockerRunner {
  readonly calls: string[][] = [];

  constructor(private readonly results: DockerCommandResult[]) {}

  async run(args: string[]): Promise<DockerCommandResult> {
    this.calls.push(args);
    const next = this.results.shift();

    if (!next) {
      throw new Error(`Unexpected docker call: docker ${args.join(' ')}`);
    }

    return next;
  }
}

const okResult = (overrides: Partial<DockerCommandResult> = {}): DockerCommandResult => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  durationMs: 5,
  ...overrides,
});

const findTool = (tools: ReturnType<typeof createBuiltInTools>, name: string) => {
  const tool = tools.find((t) => t.name === name);
  assert.ok(tool, `Tool "${name}" not found in createBuiltInTools`);
  return tool;
};

// ---------------------------------------------------------------------------
// container_start
// ---------------------------------------------------------------------------

test('container_start launches a service container and returns entry details', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const fakeContainerId = 'abc123def456';
  const docker = new FakeDockerRunner([okResult({ stdout: `${fakeContainerId}\n` })]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'container_start');

  const result = await tool.execute('call-1', {
    name: 'pg-main',
    image: 'postgres:16',
    description: 'Main postgres instance',
    ports: { '5432': 10001 },
    env: { POSTGRES_PASSWORD: 'secret' },
  });

  // Docker was called with 'run -d'
  assert.ok(docker.calls[0]?.includes('run'));
  assert.ok(docker.calls[0]?.includes('-d'));
  assert.ok(docker.calls[0]?.includes('pg-main'));
  assert.ok(docker.calls[0]?.includes('postgres:16'));

  // Port mapping was passed
  assert.ok(docker.calls[0]?.includes('-p'));
  assert.ok(docker.calls[0]?.some((arg) => arg.includes('10001:5432')));

  // Response content mentions the container name
  const text = result.content[0]?.text ?? '';
  assert.match(text, /pg-main/);

  // Port hint in response
  assert.match(text, /tailscale funnel/i);
  assert.match(text, /10001/);

  // Registry entry persisted
  const entries = await containerManager.registry.readAll();
  const entry = entries.find((e) => e.name === 'pg-main');
  assert.ok(entry);
  assert.equal(entry?.status, 'running');
  assert.equal(entry?.image, 'postgres:16');
  assert.equal(entry?.description, 'Main postgres instance');
});

test('container_start resolves env_secrets and merges with plain env', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { DB_PASSWORD: 'supersecret', ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([okResult({ stdout: 'cid\n' })]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'container_start');

  await tool.execute('call-2', {
    name: 'redis-main',
    image: 'redis:7',
    env: { PLAIN_VAR: 'visible' },
    env_secrets: ['DB_PASSWORD'],
  });

  // Both plain env and secret env are passed via -e flags
  const envFlags = docker.calls[0]?.filter((_, i, arr) => arr[i - 1] === '-e') ?? [];
  assert.ok(envFlags.some((f) => f.startsWith('PLAIN_VAR=')), 'plain env var present');
  assert.ok(envFlags.some((f) => f.startsWith('DB_PASSWORD=')), 'secret env var present');

  // Secret value itself should NOT appear in the tool result content
  const entry = (await containerManager.registry.readAll()).find((e) => e.name === 'redis-main');
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('supersecret'), 'secret value not in registry entry');
});

test('container_start is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });
  const tool = findTool(tools, 'container_start');

  await assert.rejects(
    () => tool.execute('call-3', { name: 'blocked', image: 'alpine' }),
    ValidationError,
  );

  assert.equal(docker.calls.length, 0, 'docker should not be called in readonly mode');
});

// ---------------------------------------------------------------------------
// container_stop
// ---------------------------------------------------------------------------

test('container_stop removes a running service and updates the registry', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  // First start the service so the registry has an entry
  const docker = new FakeDockerRunner([
    okResult({ stdout: 'cid\n' }), // docker run (start)
    okResult(),                     // docker rm -f (stop)
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await findTool(tools, 'container_start').execute('call-start', {
    name: 'svc-to-stop',
    image: 'nginx:alpine',
  });

  const stopResult = await findTool(tools, 'container_stop').execute('call-stop', {
    name: 'svc-to-stop',
  });

  // docker rm -f was called
  assert.ok(docker.calls[1]?.includes('rm'));
  assert.ok(docker.calls[1]?.includes('-f'));
  assert.ok(docker.calls[1]?.includes('svc-to-stop'));

  // Response text mentions the name
  assert.match(stopResult.content[0]?.text ?? '', /svc-to-stop/);

  // Registry entry is marked removed
  const entries = await containerManager.registry.readAll();
  const entry = entries.find((e) => e.name === 'svc-to-stop');
  assert.equal(entry?.status, 'removed');
  assert.ok(entry?.removed, 'removed timestamp should be set');
});

test('container_stop is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await assert.rejects(
    () => findTool(tools, 'container_stop').execute('call-4', { name: 'anything' }),
    ValidationError,
  );

  assert.equal(docker.calls.length, 0);
});

// ---------------------------------------------------------------------------
// container_exec
// ---------------------------------------------------------------------------

test('container_exec runs a command and returns stdout stderr exitCode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([
    okResult({ stdout: 'hello from container\n', stderr: '', exitCode: 0, durationMs: 12 }),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  const result = await findTool(tools, 'container_exec').execute('call-5', {
    name: 'my-service',
    command: 'echo hello from container',
  });

  // docker exec was called
  assert.ok(docker.calls[0]?.includes('exec'));
  assert.ok(docker.calls[0]?.includes('my-service'));

  // Content includes stdout
  const text = result.content[0]?.text ?? '';
  assert.match(text, /hello from container/);

  // Details are structured
  assert.equal((result.details as Record<string, unknown>).exitCode, 0);
  assert.match(String((result.details as Record<string, unknown>).stdout), /hello from container/);
});

test('container_exec surfaces non-zero exit code without throwing', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const docker = new FakeDockerRunner([
    okResult({ stdout: '', stderr: 'command not found: psql', exitCode: 127, durationMs: 3 }),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  const result = await findTool(tools, 'container_exec').execute('call-6', {
    name: 'pg',
    command: 'psql --version',
  });

  const details = result.details as Record<string, unknown>;
  assert.equal(details.exitCode, 127);
  assert.match(String(details.stderr), /command not found/);
});

test('container_exec parses structured output between sentinel markers', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
  });
  await security.load();

  const structuredStdout = [
    'some log line',
    '---CLOUDMIND_OUTPUT_START---',
    JSON.stringify({ rows: 42, table: 'users' }),
    '---CLOUDMIND_OUTPUT_END---',
  ].join('\n');

  const docker = new FakeDockerRunner([
    okResult({ stdout: structuredStdout, exitCode: 0, durationMs: 8 }),
  ]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  const result = await findTool(tools, 'container_exec').execute('call-7', {
    name: 'pg',
    command: 'node query.js',
  });

  const details = result.details as Record<string, unknown>;
  assert.ok(details.parsedOutput, 'parsedOutput should be present');
  assert.equal((details.parsedOutput as Record<string, unknown>).rows, 42);
});

test('container_exec is blocked in readonly mode', async (t) => {
  const { workspace, security } = await createSecurityFixture(t, {
    secrets: { ANTHROPIC_API_KEY: 'key' },
    security: { autonomy_level: 'readonly' },
  });
  await security.load();

  const docker = new FakeDockerRunner([]);
  const containerManager = new DockerContainerManager(workspace, { runner: docker });
  const tools = createBuiltInTools({ workspace, security, containerManager });

  await assert.rejects(
    () =>
      findTool(tools, 'container_exec').execute('call-8', {
        name: 'svc',
        command: 'echo hi',
      }),
    ValidationError,
  );

  assert.equal(docker.calls.length, 0);
});
