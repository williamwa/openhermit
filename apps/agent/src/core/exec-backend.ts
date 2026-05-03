import { spawn } from 'node:child_process';

import { NotFoundError, ValidationError } from '@openhermit/shared';

import { BoundedString, DEFAULT_EXEC_OUTPUT_MAX_BYTES } from './bounded-string.js';
import {
  type ContainerProcessResult,
  type WorkspaceContainerConfig,
  type WorkspaceContainerLifecycle,
} from './types.js';
import type { DockerContainerManager } from './container-manager.js';

// Per-backend defaults for the agent's home directory inside the exec env.
// Docker: ubuntu:24.04 ships only with `root`, so `/root`.
// E2B: official sandboxes default to a `user` account at `/home/user`.
const DOCKER_DEFAULT_USERNAME = 'root';
const DOCKER_DEFAULT_AGENT_HOME = '/root';
const E2B_DEFAULT_USERNAME = 'user';
const E2B_DEFAULT_AGENT_HOME = '/home/user';

// ── Result type (re-uses existing ContainerProcessResult) ─────────────────

export type ExecResult = ContainerProcessResult;

// ── Backend interface ─────────────────────────────────────────────────────

export interface ExecBackend {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  /** Linux username commands run as inside this backend. */
  readonly username: string;
  /** Path that maps to the agent's workspace inside the exec env. */
  readonly agentHome: string;
  /** Idempotent setup (start container, etc.). */
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
  /** Linux user to run commands as. Defaults to `root` for ubuntu images. */
  username?: string;
  /** Workspace mount path inside the container. Defaults to the user's home. */
  agent_home?: string;
  memory_limit?: string;
  cpu_shares?: number;
  lifecycle?: WorkspaceContainerLifecycle;
}

export interface HostExecBackendConfig {
  id?: string;
  type: 'host';
  label?: string;
  /** Defaults to the agent's workspace dir. */
  cwd?: string;
  shell?: string;
  env?: Record<string, string>;
  timeout_ms?: number;
}

export interface E2BExecBackendConfig {
  id?: string;
  type: 'e2b';
  label?: string;
  template: string;
  /** Linux user inside the sandbox. Defaults to e2b's `user`. */
  username?: string;
  /** Working directory inside the sandbox. Defaults to `/home/user`. */
  agent_home?: string;
  timeout_ms?: number;
  sandbox_timeout_ms?: number;
}

export type ExecBackendConfig =
  | DockerExecBackendConfig
  | HostExecBackendConfig
  | E2BExecBackendConfig;

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
  /** Persist backend state across restarts. */
  getBackendState?: () => Promise<Record<string, unknown> | null>;
  setBackendState?: (state: Record<string, unknown>) => Promise<void>;
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
  readonly username: string;
  readonly agentHome: string;
  private readonly config: WorkspaceContainerConfig;

  constructor(
    config: DockerExecBackendConfig,
    private readonly containerManager: DockerContainerManager,
    private readonly agentId: string,
  ) {
    this.id = config.id ?? 'docker';
    this.label = config.label ?? `Docker (${config.image})`;
    this.username = config.username ?? DOCKER_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? DOCKER_DEFAULT_AGENT_HOME;
    this.config = {
      image: config.image,
      mount_target: this.agentHome,
      username: this.username,
      ...(config.memory_limit ? { memory_limit: config.memory_limit } : {}),
      ...(config.cpu_shares ? { cpu_shares: config.cpu_shares } : {}),
      ...(config.lifecycle ? { lifecycle: config.lifecycle } : {}),
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

// ── Host backend ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

class HostExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'host';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  private readonly shell: string;
  private readonly env: Record<string, string> | undefined;
  private readonly timeoutMs: number;

  constructor(config: HostExecBackendConfig, workspaceDir: string) {
    this.id = config.id ?? 'host';
    this.label = config.label ?? 'Host shell';
    this.username = process.env['USER'] ?? 'unknown';
    // Host backend has no container — the workspace dir IS the agent's home
    // from its perspective (no path translation needed).
    this.agentHome = config.cwd ?? workspaceDir;
    this.shell = config.shell ?? 'sh';
    this.env = config.env;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async ensure(): Promise<void> {
    // No-op — host shell is always ready.
  }

  async exec(command: string): Promise<ExecResult> {
    const startedAt = Date.now();

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(this.shell, ['-lc', command], {
        cwd: this.agentHome,
        env: { ...process.env, ...(this.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutBuf = new BoundedString(DEFAULT_EXEC_OUTPUT_MAX_BYTES, 'stdout');
      const stderrBuf = new BoundedString(DEFAULT_EXEC_OUTPUT_MAX_BYTES, 'stderr');
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutBuf.append(chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => stderrBuf.append(chunk.toString()));

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to execute host command: ${error.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          stderrBuf.append(`\n[killed: command timed out after ${this.timeoutMs}ms]`);
        }
        resolve({
          stdout: stdoutBuf.finalize(),
          stderr: stderrBuf.finalize(),
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

// ── E2B backend ──────────────────────────────────────────────────────────

const E2B_DEFAULT_TIMEOUT_MS = 300_000;
const E2B_DEFAULT_SANDBOX_TIMEOUT_MS = 600_000; // 10 minutes idle before auto-pause

interface E2BBackendPersisted {
  sandboxId: string;
  template: string;
  cwd: string;
  updatedAt: string;
}

class E2BExecBackend implements ExecBackend {
  readonly id: string;
  readonly type = 'e2b';
  readonly label: string;
  readonly username: string;
  readonly agentHome: string;
  private readonly template: string;
  private readonly timeoutMs: number;
  private readonly sandboxTimeoutMs: number;

  private sandbox: import('e2b').Sandbox | null = null;

  constructor(
    config: E2BExecBackendConfig,
    private readonly context: BackendFactoryContext,
  ) {
    this.id = config.id ?? 'e2b';
    this.label = config.label ?? `E2B (${config.template})`;
    this.template = config.template;
    this.timeoutMs = config.timeout_ms ?? E2B_DEFAULT_TIMEOUT_MS;
    this.sandboxTimeoutMs = config.sandbox_timeout_ms ?? E2B_DEFAULT_SANDBOX_TIMEOUT_MS;
    this.username = config.username ?? E2B_DEFAULT_USERNAME;
    this.agentHome = config.agent_home ?? E2B_DEFAULT_AGENT_HOME;
  }

  async ensure(): Promise<void> {
    if (this.sandbox) return;

    const { Sandbox } = await import('e2b');
    const apiKey = process.env['E2B_API_KEY'];
    if (!apiKey) {
      throw new ValidationError(
        'E2B_API_KEY environment variable is not set. Add it to ~/.openhermit/gateway/.env to use the e2b backend.',
      );
    }

    // Try to reconnect to a previously persisted sandbox.
    const persisted = await this.loadState();
    if (persisted?.sandboxId) {
      try {
        this.sandbox = await Sandbox.connect(persisted.sandboxId, {
          apiKey,
          timeoutMs: this.sandboxTimeoutMs,
        });
        return;
      } catch {
        // Sandbox gone (killed / expired) — create a new one.
      }
    }

    // Create a new sandbox.
    this.sandbox = await Sandbox.create(this.template, {
      apiKey,
      timeoutMs: this.sandboxTimeoutMs,
      metadata: { agentId: this.context.agentId },
    });

    // Ensure workspace directory exists.
    await this.sandbox.commands.run(`mkdir -p ${this.agentHome}`);

    await this.saveState({
      sandboxId: this.sandbox.sandboxId,
      template: this.template,
      cwd: this.agentHome,
      updatedAt: new Date().toISOString(),
    });
  }

  async exec(command: string): Promise<ExecResult> {
    if (!this.sandbox) {
      await this.ensure();
    }

    const startedAt = Date.now();
    try {
      const result = await this.sandbox!.commands.run(command, {
        cwd: this.agentHome,
        timeoutMs: this.timeoutMs,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
      };
    } catch (error: unknown) {
      // e2b throws CommandExitError for non-zero exits with result attached.
      if (error && typeof error === 'object' && 'exitCode' in error && 'stdout' in error && 'stderr' in error) {
        const e = error as { exitCode: number; stdout: string; stderr: string };
        return {
          stdout: e.stdout,
          stderr: e.stderr,
          exitCode: e.exitCode,
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async shutdown(): Promise<void> {
    if (!this.sandbox) return;
    try {
      await this.sandbox.pause();
    } catch {
      // Already paused or gone — ignore.
    }
    this.sandbox = null;
  }

  private async loadState(): Promise<E2BBackendPersisted | null> {
    if (!this.context.getBackendState) return null;
    const state = await this.context.getBackendState();
    return (state?.e2b as E2BBackendPersisted) ?? null;
  }

  private async saveState(persisted: E2BBackendPersisted): Promise<void> {
    if (!this.context.setBackendState || !this.context.getBackendState) return;
    const current = (await this.context.getBackendState()) ?? {};
    await this.context.setBackendState({ ...current, e2b: persisted });
  }
}

// ── Register built-in backends ────────────────────────────────────────────

registerExecBackend('docker', (config, context) =>
  new DockerExecBackend(config as DockerExecBackendConfig, context.containerManager, context.agentId),
);

registerExecBackend('host', (config, context) =>
  new HostExecBackend(config as HostExecBackendConfig, context.workspaceDir),
);

registerExecBackend('e2b', (config, context) =>
  new E2BExecBackend(config as E2BExecBackendConfig, context),
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

  /** Create from config. Falls back to a host backend when no config is provided. */
  static fromConfig(
    execConfig: ExecConfig | undefined,
    context: BackendFactoryContext,
  ): ExecBackendManager {
    let configs: ExecBackendConfig[];
    let defaultId: string | undefined;

    if (execConfig && execConfig.backends.length > 0) {
      configs = execConfig.backends;
      defaultId = execConfig.default_backend;
    } else {
      // No exec config at all — create a host backend as fallback.
      configs = [{ type: 'host', id: 'host' }];
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
