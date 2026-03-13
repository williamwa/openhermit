import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

import { OpenHermitError, NotFoundError, ValidationError } from '@openhermit/shared';

import type {
  ContainerListEntry,
  ContainerProcessResult,
  ContainerRegistryEntry,
  ContainerStatus,
  ContainerType,
  EphemeralContainerArgs,
  ServiceContainerArgs,
} from './types.js';
import { AgentWorkspace } from './workspace.js';
import { openInternalStateDatabase } from '../internal-state/sqlite.js';

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
  runner?: DockerRunner;
  stateFilePath?: string;
}

export class ContainerRegistryStore {
  constructor(private readonly database: DatabaseSync) {}

  private serializeMetadata(entry: ContainerRegistryEntry): string {
    return JSON.stringify({
      id: entry.id,
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.ports !== undefined ? { ports: entry.ports } : {}),
      ...(entry.mount !== undefined ? { mount: entry.mount } : {}),
      ...(entry.mount_target !== undefined ? { mount_target: entry.mount_target } : {}),
      ...(entry.network !== undefined ? { network: entry.network } : {}),
      ...(entry.runtime_container_id !== undefined
        ? { runtime_container_id: entry.runtime_container_id }
        : {}),
      ...(entry.exit_code !== undefined ? { exit_code: entry.exit_code } : {}),
      created: entry.created,
      ...(entry.removed !== undefined ? { removed: entry.removed } : {}),
    });
  }

  private mapRow(
    row: {
      container_name: string;
      container_type: string;
      image: string;
      status: string;
      description: string | null;
      metadata_json: string;
    },
  ): ContainerRegistryEntry {
    const metadata = JSON.parse(row.metadata_json || '{}') as Record<string, unknown>;

    return {
      id:
        typeof metadata.id === 'string'
          ? metadata.id
          : row.container_name,
      name: row.container_name,
      image: row.image,
      type: row.container_type as ContainerType,
      status: row.status as ContainerStatus,
      ...(row.description ? { description: row.description } : {}),
      ...(typeof metadata.command === 'string' ? { command: metadata.command } : {}),
      ...(metadata.ports && typeof metadata.ports === 'object'
        ? { ports: metadata.ports as Record<string, number> }
        : {}),
      ...(typeof metadata.mount === 'string' ? { mount: metadata.mount } : {}),
      ...(typeof metadata.mount_target === 'string'
        ? { mount_target: metadata.mount_target }
        : {}),
      ...(typeof metadata.network === 'string' ? { network: metadata.network } : {}),
      ...(typeof metadata.runtime_container_id === 'string'
        ? { runtime_container_id: metadata.runtime_container_id }
        : {}),
      ...(typeof metadata.exit_code === 'number' ? { exit_code: metadata.exit_code } : {}),
      created:
        typeof metadata.created === 'string'
          ? metadata.created
          : new Date().toISOString(),
      ...(typeof metadata.removed === 'string' ? { removed: metadata.removed } : {}),
    };
  }

  async readAll(): Promise<ContainerRegistryEntry[]> {
    const rows = this.database
      .prepare(
        `SELECT container_name, container_type, image, status, description, metadata_json
         FROM container_runtime_entries
         ORDER BY json_extract(metadata_json, '$.created') ASC, container_name ASC`,
      )
      .all() as Array<{
      container_name: string;
      container_type: string;
      image: string;
      status: string;
      description: string | null;
      metadata_json: string;
    }>;

    return rows.map((row) => this.mapRow(row));
  }

  async findByName(name: string): Promise<ContainerRegistryEntry | undefined> {
    const entries = await this.readAll();
    return entries.find((entry) => entry.name === name);
  }

  async upsert(entry: ContainerRegistryEntry): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO container_runtime_entries(
          container_name,
          container_type,
          image,
          status,
          description,
          metadata_json,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(container_name) DO UPDATE SET
          container_type = excluded.container_type,
          image = excluded.image,
          status = excluded.status,
          description = excluded.description,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        entry.name,
        entry.type,
        entry.image,
        entry.status,
        entry.description ?? null,
        this.serializeMetadata(entry),
        new Date().toISOString(),
      );
  }

  async updateByName(
    name: string,
    update: (entry: ContainerRegistryEntry) => ContainerRegistryEntry,
  ): Promise<ContainerRegistryEntry> {
    const entries = await this.readAll();
    const index = entries.findIndex((entry) => entry.name === name);

    if (index === -1) {
      throw new NotFoundError(`Container not found in registry: ${name}`);
    }

    const currentEntry = entries[index];

    if (!currentEntry) {
      throw new NotFoundError(`Container not found in registry: ${name}`);
    }

    const updated = update(currentEntry);
    await this.upsert(updated);
    return updated;
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
  private readonly database: DatabaseSync;

  readonly registry: ContainerRegistryStore;

  constructor(
    private readonly workspace: AgentWorkspace,
    options: DockerContainerManagerOptions = {},
  ) {
    this.docker = options.runner ?? new DockerCliRunner();
    this.database = openInternalStateDatabase(
      options.stateFilePath
      ?? path.join(workspace.root, '.openhermit-internal', 'state.sqlite'),
    );
    this.registry = new ContainerRegistryStore(this.database);
  }

  private async requireRegisteredService(
    name: string,
  ): Promise<ContainerRegistryEntry> {
    const entry = await this.registry.findByName(name);

    if (!entry || entry.type !== 'service') {
      throw new NotFoundError(`Service container not found in registry: ${name}`);
    }

    return entry;
  }

  async runEphemeral(
    args: EphemeralContainerArgs,
  ): Promise<ContainerProcessResult & { container: ContainerRegistryEntry }> {
    const name = `run-${Date.now()}-${randomUUID().slice(0, 8)}`;
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
    const mountRelative = normalizeContainerRelativePath(
      args.mount ?? `containers/${args.name}/data`,
    );

    if (!isContainerMountPath(mountRelative)) {
      throw new ValidationError(
        `Service mount path must stay under containers/{name}/data: ${mountRelative}`,
      );
    }

    const existing = await this.registry.findByName(args.name);

    if (existing && existing.status === 'running') {
      throw new ValidationError(`Service container already running: ${args.name}`);
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

    const dockerArgs = [
      'run',
      '-d',
      '--name',
      args.name,
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
      name: args.name,
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

    if (entry.status === 'removed') {
      return entry;
    }

    const result = await this.docker.run(['rm', '-f', name]);
    const missingContainer =
      result.exitCode !== 0 &&
      /No such container/i.test(`${result.stdout}\n${result.stderr}`);

    if (result.exitCode !== 0 && !missingContainer) {
      throw new OpenHermitError(
        `Failed to stop service container: ${result.stderr || result.stdout}`,
        'docker_remove_failed',
        500,
      );
    }

    return this.registry.updateByName(name, (current) => ({
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

    const result = await this.docker.run(['exec', name, 'sh', '-lc', command]);
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
}
