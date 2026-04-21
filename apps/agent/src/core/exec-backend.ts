import { spawn } from 'node:child_process';

import { NotFoundError, ValidationError } from '@openhermit/shared';

import type { ContainerProcessResult, WorkspaceContainerConfig, WorkspaceContainerLifecycle } from './types.js';
import type { DockerContainerManager } from './container-manager.js';

// ── Result type (re-uses existing ContainerProcessResult) ─────────────────

export type ExecResult = ContainerProcessResult;

// ── Backend interface ─────────────────────────────────────────────────────

export interface ExecBackend {
  /** Unique instance id, e.g. "docker", "local", "prod-ssh". */
  readonly id: string;
  /** Backend type: "docker" | "local" | "ssh" | custom. */
  readonly type: string;
  /** Human-readable label for the LLM. */
  readonly label: string;
  /** Idempotent setup (start container, verify SSH, etc.). */
  ensure(): Promise<void>;
  /** Execute a shell command and return the result. */
  exec(command: string): Promise<ExecResult>;
  /** Teardown (stop container, etc.). No-op if nothing to clean up. */
  shutdown(): Promise<void>;
}

// ── Config types ──────────────────────────────────────────────────────────

export interface DockerExecBackendConfig {
  id?: string;
  type: 'docker';
  label?: string;
  image: string;
  memory_limit?: string;
  cpu_shares?: number;
  lifecycle?: WorkspaceContainerLifecycle;
}

export interface LocalExecBackendConfig {
  id?: string;
  type: 'local';
  label?: string;
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface SshExecBackendConfig {
  id?: string;
  type: 'ssh';
  label?: string;
  host: string;
  port?: number;
  user?: string;
  identity_file?: string;
  cwd?: string;
  timeout_ms?: number;
}

export type ExecBackendConfig =
  | DockerExecBackendConfig
  | LocalExecBackendConfig
  | SshExecBackendConfig;

export interface ExecConfig {
  backends: ExecBackendConfig[];
  default_backend?: string;
  lifecycle?: WorkspaceContainerLifecycle;
}

// ── Backend factory registry ──────────────────────────────────────────────

export interface BackendFactoryContext {
  containerManager: DockerContainerManager;
  agentId: string;
  workspaceDir: string;
  /** Extra read-only bind mounts for workspace containers (e.g. skill directories). */
  extraBindMounts?: string[];
}

type BackendFactory = (config: ExecBackendConfig, context: BackendFactoryContext) => ExecBackend;

const factories = new Map<string, BackendFactory>();

export const registerExecBackend = (type: string, factory: BackendFactory): void => {
  factories.set(type, factory);
};

export const createExecBackend = (config: ExecBackendConfig, context: BackendFactoryContext): ExecBackend => {
  const factory = factories.get(config.type);
  if (!factory) {
    throw new ValidationError(`Unknown exec backend type: ${config.type}`);
  }
  return factory(config, context);
};

// ── Docker backend ────────────────────────────────────────────────────────

class DockerExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'docker';
  readonly label: string;
  private readonly config: WorkspaceContainerConfig;

  constructor(
    config: DockerExecBackendConfig,
    private readonly containerManager: DockerContainerManager,
    private readonly agentId: string,
    extraBindMounts?: string[],
  ) {
    this.id = config.id ?? 'docker';
    this.label = config.label ?? `Docker (${config.image})`;
    this.config = {
      image: config.image,
      ...(config.memory_limit ? { memory_limit: config.memory_limit } : {}),
      ...(config.cpu_shares ? { cpu_shares: config.cpu_shares } : {}),
      ...(config.lifecycle ? { lifecycle: config.lifecycle } : {}),
      ...(extraBindMounts && extraBindMounts.length > 0 ? { extraBindMounts } : {}),
    };
  }

  async ensure(): Promise<void> {
    await this.containerManager.ensureWorkspaceContainer(this.agentId, this.config);
  }

  async exec(command: string): Promise<ExecResult> {
    return this.containerManager.execInWorkspace(this.agentId, command);
  }

  async shutdown(): Promise<void> {
    await this.containerManager.stopWorkspaceContainer(this.agentId);
  }
}

// ── Local backend ─────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

class LocalExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'local';
  readonly label: string;
  private readonly cwd: string;
  private readonly shell: string;
  private readonly env: Record<string, string> | undefined;
  private readonly timeoutMs: number;

  constructor(config: LocalExecBackendConfig, workspaceDir: string) {
    this.id = config.id ?? 'local';
    this.label = config.label ?? 'Local shell';
    this.cwd = config.cwd ?? workspaceDir;
    this.shell = config.shell ?? 'sh';
    this.env = config.env;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async ensure(): Promise<void> {
    // No-op — local shell is always ready.
  }

  async exec(command: string): Promise<ExecResult> {
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(this.shell, ['-lc', command], {
        cwd: this.cwd,
        env: { ...process.env, ...(this.env ?? {}) },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to execute local command: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          stderr = stderr.trimEnd() + `\n[killed: command timed out after ${this.timeoutMs}ms]`;
        }
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 137 : (code ?? 1),
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  async shutdown(): Promise<void> {
    // No-op.
  }
}

// ── SSH backend ───────────────────────────────────────────────────────────

class SshExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'ssh';
  readonly label: string;
  private readonly host: string;
  private readonly port: number;
  private readonly user: string | undefined;
  private readonly identityFile: string | undefined;
  private readonly cwd: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: SshExecBackendConfig) {
    this.id = config.id ?? 'ssh';
    this.label = config.label ?? `SSH (${config.user ? `${config.user}@` : ''}${config.host})`;
    this.host = config.host;
    this.port = config.port ?? 22;
    this.user = config.user;
    this.identityFile = config.identity_file;
    this.cwd = config.cwd;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  private buildSshArgs(remoteCommand: string): string[] {
    const args: string[] = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      '-p', String(this.port),
    ];
    if (this.identityFile) {
      args.push('-i', this.identityFile);
    }
    const target = this.user ? `${this.user}@${this.host}` : this.host;
    args.push(target, '--', remoteCommand);
    return args;
  }

  async ensure(): Promise<void> {
    // Verify connectivity with a quick echo.
    const result = await this.exec('echo ok');
    if (result.exitCode !== 0) {
      throw new ValidationError(
        `SSH connectivity check failed for ${this.host}: ${result.stderr.trim()}`,
      );
    }
  }

  async exec(command: string): Promise<ExecResult> {
    const wrappedCommand = this.cwd
      ? `cd ${shellEscape(this.cwd)} && ${command}`
      : command;
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn('ssh', this.buildSshArgs(wrappedCommand), {
        env: process.env,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to execute SSH command: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          stderr = stderr.trimEnd() + `\n[killed: command timed out after ${this.timeoutMs}ms]`;
        }
        resolve({
          stdout,
          stderr,
          exitCode: timedOut ? 137 : (code ?? 1),
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }

  async shutdown(): Promise<void> {
    // No-op — no persistent connection.
  }
}

/** Minimal shell-safe escaping for a single argument. */
const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// ── Register built-in backends ────────────────────────────────────────────

registerExecBackend('docker', (config, context) =>
  new DockerExecBackend(config as DockerExecBackendConfig, context.containerManager, context.agentId, context.extraBindMounts),
);

registerExecBackend('local', (config, context) =>
  new LocalExecBackend(config as LocalExecBackendConfig, context.workspaceDir),
);

registerExecBackend('ssh', (config) =>
  new SshExecBackend(config as SshExecBackendConfig),
);

// ── ExecBackendManager ────────────────────────────────────────────────────

export class ExecBackendManager {
  private readonly backends: Map<string, ExecBackend>;
  private readonly defaultId: string;

  constructor(backends: ExecBackend[], defaultId?: string) {
    this.backends = new Map(backends.map((b) => [b.id, b]));
    if (backends.length === 0) {
      throw new ValidationError('At least one exec backend must be configured.');
    }
    this.defaultId = defaultId ?? backends[0]!.id;
    if (!this.backends.has(this.defaultId)) {
      throw new ValidationError(`Default exec backend not found: ${this.defaultId}`);
    }
  }

  /** Create from config. Falls back to a local backend when no config is provided. */
  static fromConfig(
    execConfig: ExecConfig | undefined,
    context: BackendFactoryContext,
    skillBindMounts?: string[],
  ): ExecBackendManager {
    if (skillBindMounts && skillBindMounts.length > 0) {
      context = { ...context, extraBindMounts: skillBindMounts };
    }
    let configs: ExecBackendConfig[];
    let defaultId: string | undefined;

    if (execConfig && execConfig.backends.length > 0) {
      configs = execConfig.backends;
      defaultId = execConfig.default_backend;
    } else {
      // No exec config at all — create a local backend as fallback.
      configs = [{ type: 'local', id: 'local' }];
    }

    // Assign default ids for configs without explicit id.
    const usedIds = new Set<string>();
    for (const config of configs) {
      if (!config.id) {
        let candidate: string = config.type;
        let counter = 2;
        while (usedIds.has(candidate)) {
          candidate = `${config.type}-${counter++}`;
        }
        (config as { id?: string }).id = candidate;
      }
      usedIds.add(config.id!);
    }

    const backends = configs.map((c) => createExecBackend(c, context));
    return new ExecBackendManager(backends, defaultId);
  }

  get(id?: string): ExecBackend {
    const targetId = id ?? this.defaultId;
    const backend = this.backends.get(targetId);
    if (!backend) {
      throw new NotFoundError(`Exec backend not found: ${targetId}`);
    }
    return backend;
  }

  getDefault(): ExecBackend {
    return this.get(this.defaultId);
  }

  list(): ExecBackend[] {
    return [...this.backends.values()];
  }

  async shutdownAll(): Promise<void> {
    await Promise.allSettled(
      [...this.backends.values()].map((b) => b.shutdown()),
    );
  }
}
