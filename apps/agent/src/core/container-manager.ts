import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { OpenHermitError, NotFoundError, ValidationError } from '@openhermit/shared';
import {
  type ContainerStore,
  type StoreScope,
  SqliteInternalStateStore,
  standaloneScope,
} from '@openhermit/store';

import type {
  ContainerListEntry,
  ContainerProcessResult,
  ContainerRegistryEntry,
  ContainerStatus,
  ContainerType,
  EphemeralContainerArgs,
  ServiceContainerArgs,
  WorkspaceContainerConfig,
} from './types.js';
import { AgentWorkspace } from './workspace.js';

const OUTPUT_START = '---OPENHERMIT_OUTPUT_START---';
const OUTPUT_END = '---OPENHERMIT_OUTPUT_END---';

const normalizeContainerRelativePath = (relativePath: string): string =>
  path.posix.normalize(relativePath.split(path.sep).join(path.posix.sep));

const isContainerMountPath = (relativePath: string): boolean => {
  const normalized = normalizeContainerRelativePath(relativePath);

  if (
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    return false;
  }

  const segments = normalized.split('/').filter(Boolean);

  return segments.length >= 3 && segments[0] === 'containers' && segments[2] === 'data';
};

const normalizeContainerMountTarget = (targetPath: string): string =>
  path.posix.normalize(targetPath.split(path.sep).join(path.posix.sep));

const isValidContainerMountTarget = (targetPath: string): boolean => {
  const normalized = normalizeContainerMountTarget(targetPath);

  return (
    normalized.length > 1 &&
    normalized.startsWith('/') &&
    normalized !== '/.' &&
    normalized !== '/..' &&
    !normalized.includes('/../')
  );
};

const parseStructuredOutput = (stdout: string): unknown => {
  const startIndex = stdout.indexOf(OUTPUT_START);
  const endIndex = stdout.indexOf(OUTPUT_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return undefined;
  }

  const jsonPayload = stdout
    .slice(startIndex + OUTPUT_START.length, endIndex)
    .trim();

  if (!jsonPayload) {
    return undefined;
  }

  try {
    return JSON.parse(jsonPayload);
  } catch {
    return jsonPayload;
  }
};

const deriveContainerStatus = (statusText: string | undefined): ContainerStatus => {
  if (!statusText) {
    return 'unknown';
  }

  if (statusText.startsWith('Up ')) {
    return 'running';
  }

  if (statusText.startsWith('Exited')) {
    return 'exited';
  }

  if (statusText.startsWith('Created')) {
    return 'created';
  }

  if (statusText.startsWith('Removed')) {
    return 'removed';
  }

  return 'unknown';
};

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface DockerRunner {
  run(args: string[]): Promise<DockerCommandResult>;
}

class DockerCliRunner implements DockerRunner {
  constructor(
    private readonly binary =
      process.env.OPENHERMIT_DOCKER_BIN ??
      'docker',
  ) {}

  async run(args: string[]): Promise<DockerCommandResult> {
    const startedAt = Date.now();

    return new Promise<DockerCommandResult>((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        reject(
          new OpenHermitError(
            `Failed to execute docker command: ${error.message}`,
            'docker_unavailable',
            500,
          ),
        );
      });

      child.on('close', (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}

export interface DockerContainerManagerOptions {
  agentId?: string;
  runner?: DockerRunner;
  stateFilePath?: string;
  containerStore?: ContainerStore;
  storeScope?: StoreScope;
}

/**
 * Scope-bound container registry that delegates to a `ContainerStore` with
 * a fixed `StoreScope`.  Provides the same call signatures as the old
 * `ContainerRegistryStore` so internal callers don't need to pass scope.
 */
class ScopedContainerRegistry {
  constructor(
    private readonly store: ContainerStore,
    private readonly scope: StoreScope,
  ) {}

  async readAll(): Promise<ContainerRegistryEntry[]> {
    return this.store.readAll(this.scope);
  }

  async findByName(name: string): Promise<ContainerRegistryEntry | undefined> {
    return this.store.findByName(this.scope, name);
  }

  async upsert(entry: ContainerRegistryEntry): Promise<void> {
    return this.store.upsert(this.scope, entry);
  }

  async updateByName(
    name: string,
    update: (entry: ContainerRegistryEntry) => ContainerRegistryEntry,
  ): Promise<ContainerRegistryEntry> {
    return this.store.updateByName(this.scope, name, update);
  }
}

interface LiveDockerContainer {
  id: string;
  names: string;
  image: string;
  statusText: string;
}

export class DockerContainerManager {
  private readonly docker: DockerRunner;
  private readonly agentId: string;

  readonly registry: ScopedContainerRegistry;

  constructor(
    private readonly workspace: AgentWorkspace,
    options: DockerContainerManagerOptions = {},
  ) {
    this.docker = options.runner ?? new DockerCliRunner();
    this.agentId = options.agentId ?? 'default';

    if (options.containerStore) {
      this.registry = new ScopedContainerRegistry(
        options.containerStore,
        options.storeScope ?? standaloneScope,
      );
    } else {
      const store = SqliteInternalStateStore.open(
        options.stateFilePath
        ?? path.join(workspace.root, '.openhermit-internal', 'state.sqlite'),
      );
      this.registry = new ScopedContainerRegistry(
        store.containers,
        standaloneScope,
      );
    }
  }

  private async requireRegisteredService(
    userFacingName: string,
  ): Promise<ContainerRegistryEntry> {
    const name = this.containerName(userFacingName);
    const entry = await this.registry.findByName(name);

    if (!entry || entry.type !== 'service') {
      throw new NotFoundError(`Service container not found in registry: ${userFacingName}`);
    }

    return entry;
  }

  async runEphemeral(
    args: EphemeralContainerArgs,
  ): Promise<ContainerProcessResult & { container: ContainerRegistryEntry }> {
    const name = this.containerName(`run-${Date.now()}-${randomUUID().slice(0, 8)}`);
    const mountRelative = normalizeContainerRelativePath(
      args.mount ?? `containers/${name}/data`,
    );

    if (!isContainerMountPath(mountRelative)) {
      throw new ValidationError(
        `Ephemeral mount path must stay under containers/{name}/data: ${mountRelative}`,
      );
    }

    const mountPath = await this.workspace.resolve(mountRelative);
    await fs.mkdir(mountPath, { recursive: true });
    const mountTarget = normalizeContainerMountTarget(
      args.mount_target ?? '/workspace',
    );

    if (!isValidContainerMountTarget(mountTarget)) {
      throw new ValidationError(
        `Ephemeral mount target must be an absolute in-container path: ${mountTarget}`,
      );
    }

    const entry: ContainerRegistryEntry = {
      id: randomUUID(),
      name,
      image: args.image,
      type: 'ephemeral',
      status: 'created',
      ...(args.description ? { description: args.description } : {}),
      command: args.command,
      mount: this.workspace.toRelativePath(mountPath),
      mount_target: mountTarget,
      created: new Date().toISOString(),
    };
    await this.registry.upsert(entry);

    const dockerArgs = [
      'run',
      '--rm',
      '--name',
      name,
      '-v',
      `${mountPath}:${mountTarget}`,
      '-w',
      args.workdir ?? mountTarget,
    ];

    for (const [key, value] of Object.entries(args.env ?? {})) {
      dockerArgs.push('-e', `${key}=${value}`);
    }

    dockerArgs.push(args.image, 'sh', '-lc', args.command);

    const result = await this.docker.run(dockerArgs);
    const parsedOutput = parseStructuredOutput(result.stdout);
    const finalizedEntry: ContainerRegistryEntry = {
      ...entry,
      status: 'removed',
      exit_code: result.exitCode,
      removed: new Date().toISOString(),
    };
    await this.registry.upsert(finalizedEntry);

    return {
      ...result,
      ...(parsedOutput !== undefined ? { parsedOutput } : {}),
      container: finalizedEntry,
    };
  }

  async startService(args: ServiceContainerArgs): Promise<ContainerRegistryEntry> {
    const name = this.containerName(args.name);
    const mountRelative = normalizeContainerRelativePath(
      args.mount ?? `containers/${args.name}/data`,
    );

    if (!isContainerMountPath(mountRelative)) {
      throw new ValidationError(
        `Service mount path must stay under containers/{name}/data: ${mountRelative}`,
      );
    }

    const existing = await this.registry.findByName(name);

    if (existing && existing.status === 'running') {
      throw new ValidationError(`Service container already running: ${name}`);
    }

    // Restart a stopped container instead of creating a new one.
    if (existing && existing.status === 'stopped') {
      const result = await this.docker.run(['start', name]);

      if (result.exitCode !== 0) {
        throw new OpenHermitError(
          `Failed to restart service container: ${result.stderr || result.stdout}`,
          'docker_run_failed',
          500,
        );
      }

      return this.registry.updateByName(name, (current) => ({
        ...current,
        status: 'running',
      }));
    }

    const mountPath = await this.workspace.resolve(mountRelative);
    await fs.mkdir(mountPath, { recursive: true });
    const mountTarget = normalizeContainerMountTarget(
      args.mount_target ?? '/data',
    );

    if (!isValidContainerMountTarget(mountTarget)) {
      throw new ValidationError(
        `Service mount target must be an absolute in-container path: ${mountTarget}`,
      );
    }

    // Remove stale removed container so the name is available.
    if (existing && existing.status === 'removed') {
      await this.docker.run(['rm', '-f', name]);
    }

    const dockerArgs = [
      'run',
      '-d',
      '--name',
      name,
      '-v',
      `${mountPath}:${mountTarget}`,
    ];

    for (const [containerPort, hostPort] of Object.entries(args.ports ?? {})) {
      dockerArgs.push('-p', `${hostPort}:${containerPort}`);
    }

    for (const [key, value] of Object.entries(args.env ?? {})) {
      dockerArgs.push('-e', `${key}=${value}`);
    }

    if (args.network) {
      dockerArgs.push('--network', args.network);
    }

    dockerArgs.push(args.image);

    const result = await this.docker.run(dockerArgs);

    if (result.exitCode !== 0) {
      throw new OpenHermitError(
        `Failed to start service container: ${result.stderr || result.stdout}`,
        'docker_run_failed',
        500,
      );
    }

    const runtimeContainerId = result.stdout.trim() || existing?.runtime_container_id;
    const entry: ContainerRegistryEntry = {
      id: existing?.id ?? randomUUID(),
      name,
      image: args.image,
      type: 'service',
      status: 'running',
      ...(args.description ? { description: args.description } : {}),
      ...(args.ports ? { ports: args.ports } : {}),
      mount: this.workspace.toRelativePath(mountPath),
      mount_target: mountTarget,
      ...(args.network ? { network: args.network } : {}),
      ...(runtimeContainerId ? { runtime_container_id: runtimeContainerId } : {}),
      created: existing?.created ?? new Date().toISOString(),
    };

    await this.registry.upsert(entry);
    return entry;
  }

  async stopService(name: string): Promise<ContainerRegistryEntry> {
    const entry = await this.requireRegisteredService(name);

    if (entry.status === 'stopped' || entry.status === 'removed') {
      return entry;
    }

    const result = await this.docker.run(['stop', entry.name]);
    const missingContainer =
      result.exitCode !== 0 &&
      /No such container/i.test(`${result.stdout}\n${result.stderr}`);

    if (result.exitCode !== 0 && !missingContainer) {
      throw new OpenHermitError(
        `Failed to stop service container: ${result.stderr || result.stdout}`,
        'docker_stop_failed',
        500,
      );
    }

    return this.registry.updateByName(entry.name, (current) => ({
      ...current,
      status: missingContainer ? 'removed' : 'stopped',
    }));
  }

  async removeService(name: string): Promise<ContainerRegistryEntry> {
    const entry = await this.requireRegisteredService(name);

    if (entry.status === 'removed') {
      return entry;
    }

    const result = await this.docker.run(['rm', '-f', entry.name]);
    const missingContainer =
      result.exitCode !== 0 &&
      /No such container/i.test(`${result.stdout}\n${result.stderr}`);

    if (result.exitCode !== 0 && !missingContainer) {
      throw new OpenHermitError(
        `Failed to remove service container: ${result.stderr || result.stdout}`,
        'docker_remove_failed',
        500,
      );
    }

    return this.registry.updateByName(entry.name, (current) => ({
      ...current,
      status: 'removed',
      removed: new Date().toISOString(),
    }));
  }

  async execInService(
    name: string,
    command: string,
  ): Promise<ContainerProcessResult> {
    const entry = await this.requireRegisteredService(name);

    if (entry.status !== 'running') {
      throw new ValidationError(`Service container is not running: ${name}`);
    }

    const result = await this.docker.run(['exec', entry.name, 'sh', '-lc', command]);
    const parsedOutput = parseStructuredOutput(result.stdout);

    return {
      ...result,
      ...(parsedOutput !== undefined ? { parsedOutput } : {}),
    };
  }

  async listAll(): Promise<ContainerListEntry[]> {
    const [registryEntries, liveContainers] = await Promise.all([
      this.registry.readAll(),
      this.listLiveContainers().catch(() => []),
    ]);

    const liveByName = new Map(
      liveContainers.map((container) => [container.names, container]),
    );

    return registryEntries.map((entry) => {
      const live = liveByName.get(entry.name);

      if (!live) {
        return entry;
      }

      return {
        ...entry,
        status: deriveContainerStatus(live.statusText),
        runtime_container_id: live.id,
        live_status_text: live.statusText,
      };
    });
  }

  private async listLiveContainers(): Promise<LiveDockerContainer[]> {
    const result = await this.docker.run(['ps', '-a', '--format', '{{json .}}']);

    if (result.exitCode !== 0) {
      throw new OpenHermitError(
        `Failed to inspect docker containers: ${result.stderr || result.stdout}`,
        'docker_ps_failed',
        500,
      );
    }

    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, string>)
      .map((container) => ({
        id: container.ID ?? '',
        names: container.Names ?? '',
        image: container.Image ?? '',
        statusText: container.Status ?? '',
      }));
  }

  private containerName(suffix: string): string {
    return `openhermit-${this.agentId}-${suffix}`;
  }

  async getWorkspaceContainer(
    agentId: string,
  ): Promise<ContainerRegistryEntry | undefined> {
    return this.registry.findByName(this.containerName('workspace'));
  }

  /**
   * Ensure a persistent workspace container exists for the given agent.
   * Idempotent: creates if missing, starts if stopped, returns if running.
   */
  async ensureWorkspaceContainer(
    agentId: string,
    config: WorkspaceContainerConfig,
  ): Promise<ContainerRegistryEntry> {
    const name = this.containerName('workspace');
    const mountTarget = '/workspace';

    const existing = await this.registry.findByName(name);

    if (existing) {
      // Check live status
      const liveContainers = await this.listLiveContainers().catch(() => []);
      const live = liveContainers.find((c) => c.names === name);
      const liveStatus = live ? deriveContainerStatus(live.statusText) : undefined;

      if (liveStatus === 'running') {
        return this.registry.updateByName(name, (current) => ({
          ...current,
          status: 'running',
          runtime_container_id: live!.id,
        }));
      }

      // Container exists but is stopped — restart it.
      if (liveStatus === 'exited' || existing.status === 'stopped') {
        const startResult = await this.docker.run(['start', name]);

        if (startResult.exitCode === 0) {
          return this.registry.updateByName(name, (current) => ({
            ...current,
            status: 'running',
          }));
        }
      }

      // Container is in an unrecoverable state — remove and recreate.
      if (liveStatus) {
        await this.docker.run(['rm', '-f', name]);
      }
    }

    // Create the workspace container
    const workspaceRoot = this.workspace.root;
    const dockerArgs = [
      'run',
      '-d',
      '--name',
      name,
      '-v',
      `${workspaceRoot}:${mountTarget}`,
      '-w',
      mountTarget,
    ];

    if (config.memory_limit) {
      dockerArgs.push('--memory', config.memory_limit);
    }

    if (config.cpu_shares) {
      dockerArgs.push('--cpu-shares', String(config.cpu_shares));
    }

    // Keep container alive with a long-running process
    dockerArgs.push(config.image, 'sleep', 'infinity');

    const result = await this.docker.run(dockerArgs);

    if (result.exitCode !== 0) {
      throw new OpenHermitError(
        `Failed to start workspace container: ${result.stderr || result.stdout}`,
        'docker_run_failed',
        500,
      );
    }

    const runtimeContainerId = result.stdout.trim();
    const entry: ContainerRegistryEntry = {
      id: existing?.id ?? randomUUID(),
      name,
      image: config.image,
      type: 'workspace',
      status: 'running',
      description: `Persistent workspace container for agent ${agentId}`,
      mount: '.',
      mount_target: mountTarget,
      ...(runtimeContainerId ? { runtime_container_id: runtimeContainerId } : {}),
      created: existing?.created ?? new Date().toISOString(),
    };

    await this.registry.upsert(entry);
    return entry;
  }

  async stopWorkspaceContainer(agentId: string): Promise<void> {
    const name = this.containerName('workspace');
    const entry = await this.registry.findByName(name);

    if (!entry || entry.status === 'stopped' || entry.status === 'removed') {
      return;
    }

    await this.docker.run(['stop', name]);
    await this.registry.updateByName(name, (current) => ({
      ...current,
      status: 'stopped',
    }));
  }

  async execInWorkspace(
    agentId: string,
    command: string,
  ): Promise<ContainerProcessResult> {
    const name = this.containerName('workspace');
    const entry = await this.registry.findByName(name);

    if (!entry || entry.type !== 'workspace') {
      throw new NotFoundError(`Workspace container not found: ${name}`);
    }

    if (entry.status !== 'running') {
      throw new ValidationError(`Workspace container is not running: ${name}`);
    }

    const result = await this.docker.run(['exec', name, 'sh', '-lc', command]);
    const parsedOutput = parseStructuredOutput(result.stdout);

    return {
      ...result,
      ...(parsedOutput !== undefined ? { parsedOutput } : {}),
    };
  }
}
