import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { OpenHermitError, NotFoundError, ValidationError } from '@openhermit/shared';

import type {
  ContainerProcessResult,
  ContainerRegistryEntry,
  ContainerStatus,
  WorkspaceContainerConfig,
} from './types.js';
import { AgentWorkspace } from './workspace.js';

const OUTPUT_START = '---OPENHERMIT_OUTPUT_START---';
const OUTPUT_END = '---OPENHERMIT_OUTPUT_END---';

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
  if (!statusText) return 'unknown';
  if (statusText.startsWith('Up ')) return 'running';
  if (statusText.startsWith('Exited')) return 'exited';
  if (statusText.startsWith('Created')) return 'created';
  if (statusText.startsWith('Removed')) return 'removed';
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
  private workspaceEntry: ContainerRegistryEntry | undefined;

  constructor(
    private readonly workspace: AgentWorkspace,
    options: DockerContainerManagerOptions = {},
  ) {
    this.docker = options.runner ?? new DockerCliRunner();
    this.agentId = options.agentId ?? 'default';
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

  async ensureWorkspaceContainer(
    agentId: string,
    config: WorkspaceContainerConfig,
  ): Promise<ContainerRegistryEntry> {
    const name = this.containerName('workspace');
    const mountTarget = '/workspace';

    const liveContainers = await this.listLiveContainers().catch(() => []);
    const live = liveContainers.find((c) => c.names === name);
    const liveStatus = live ? deriveContainerStatus(live.statusText) : undefined;

    if (liveStatus === 'running') {
      this.workspaceEntry = {
        ...(this.workspaceEntry ?? {
          id: live!.id,
          name,
          image: config.image,
          type: 'workspace' as const,
          mount: '.',
          mount_target: mountTarget,
          created: new Date().toISOString(),
        }),
        status: 'running',
        runtime_container_id: live!.id,
      };
      return this.workspaceEntry;
    }

    if (liveStatus === 'exited' || (this.workspaceEntry?.status === 'stopped' && liveStatus)) {
      const startResult = await this.docker.run(['start', name]);
      if (startResult.exitCode === 0) {
        this.workspaceEntry = { ...this.workspaceEntry!, status: 'running' };
        return this.workspaceEntry;
      }
    }

    // Remove stale container if it exists in an unrecoverable state.
    if (liveStatus) {
      await this.docker.run(['rm', '-f', name]);
    }

    const workspaceRoot = this.workspace.root;
    const dockerArgs = [
      'run', '-d',
      '--name', name,
      '-v', `${workspaceRoot}:${mountTarget}`,
      '-w', mountTarget,
    ];

    if (config.memory_limit) {
      dockerArgs.push('--memory', config.memory_limit);
    }
    if (config.cpu_shares) {
      dockerArgs.push('--cpu-shares', String(config.cpu_shares));
    }
    if (config.skillMountsDir) {
      dockerArgs.push('-v', `${config.skillMountsDir}:/skills:ro`);
    }

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
    this.workspaceEntry = {
      id: this.workspaceEntry?.id ?? randomUUID(),
      name,
      image: config.image,
      type: 'workspace',
      status: 'running',
      mount: '.',
      mount_target: mountTarget,
      ...(runtimeContainerId ? { runtime_container_id: runtimeContainerId } : {}),
      created: this.workspaceEntry?.created ?? new Date().toISOString(),
    };

    return this.workspaceEntry;
  }

  async stopWorkspaceContainer(agentId: string): Promise<void> {
    const name = this.containerName('workspace');

    if (this.workspaceEntry && (this.workspaceEntry.status === 'stopped' || this.workspaceEntry.status === 'removed')) {
      return;
    }

    await this.docker.run(['stop', name]);
    if (this.workspaceEntry) {
      this.workspaceEntry = { ...this.workspaceEntry, status: 'stopped' };
    }
  }

  async execInWorkspace(
    agentId: string,
    command: string,
  ): Promise<ContainerProcessResult> {
    const name = this.containerName('workspace');

    if (!this.workspaceEntry || this.workspaceEntry.type !== 'workspace') {
      throw new NotFoundError(`Workspace container not found: ${name}`);
    }

    if (this.workspaceEntry.status !== 'running') {
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
