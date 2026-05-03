import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

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

export interface SyncSkillEntry {
  /** Skill folder name; becomes the basename of the synced directory. */
  id: string;
  /** Absolute path on the gateway host to copy from. */
  sourcePath: string;
}

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
  /**
   * Make `<agentHome>/.openhermit/skills/system/` reflect exactly the given
   * skill set inside the exec env: copies in, removes stale entries.
   */
  syncSkills(skills: SyncSkillEntry[]): Promise<void>;
  /** Teardown (stop container, etc.). No-op if nothing to clean up. */
  shutdown(): Promise<void>;
}

/** Copy enabled skills into a host-side directory, removing stale entries. */
const syncSkillsToHostDir = async (
  systemSkillsDir: string,
  skills: SyncSkillEntry[],
): Promise<void> => {
  await mkdir(systemSkillsDir, { recursive: true });

  const desired = new Map(skills.map((s) => [s.id, s.sourcePath]));

  let existing: string[];
  try {
    existing = await readdir(systemSkillsDir);
  } catch {
    existing = [];
  }

  for (const name of existing) {
    if (!desired.has(name)) {
      await rm(path.join(systemSkillsDir, name), { recursive: true, force: true });
    }
  }

  for (const [id, sourcePath] of desired) {
    const destPath = path.join(systemSkillsDir, id);
    await rm(destPath, { recursive: true, force: true });
    await cp(sourcePath, destPath, { recursive: true });
  }
};

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
  /**
   * Persist runtime state for THIS backend's sandbox row. When backends
   * are constructed from sandbox-store rows, these helpers read/write the
   * row's `runtime_state` JSONB; legacy fromConfig path leaves them
   * undefined (no persistence).
   */
  getRuntimeState?: () => Promise<Record<string, unknown> | null>;
  setRuntimeState?: (state: Record<string, unknown>) => Promise<void>;
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
    private readonly workspaceDir: string,
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

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    // Workspace dir is bind-mounted into the container at agentHome,
    // so writing to <workspaceDir>/.openhermit/skills/system makes the
    // skills visible inside the container at <agentHome>/.openhermit/skills/system.
    await syncSkillsToHostDir(
      path.join(this.workspaceDir, '.openhermit', 'skills', 'system'),
      skills,
    );
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

  constructor(config: HostExecBackendConfig, _workspaceDir: string) {
    this.id = config.id ?? 'host';
    this.label = config.label ?? 'Host shell';
    this.username = process.env['USER'] ?? 'unknown';
    // Host backend treats the entire gateway machine as the sandbox: the
    // agent's home is the running user's $HOME. At most one host-backend
    // agent can exist per gateway (enforced at the gateway layer).
    const home = process.env['HOME'];
    if (!home) {
      throw new ValidationError('HOME environment variable is not set; cannot use host exec backend.');
    }
    this.agentHome = config.cwd ?? home;
    this.shell = config.shell ?? 'sh';
    this.env = config.env;
    this.timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  }

  async ensure(): Promise<void> {
    // No-op — host shell is always ready.
  }

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    await syncSkillsToHostDir(
      path.join(this.agentHome, '.openhermit', 'skills', 'system'),
      skills,
    );
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

/**
 * Recursively upload a host directory to an e2b sandbox path.
 * Reads each file with node:fs and pushes via the e2b SDK.
 */
const uploadDirToE2B = async (
  sandbox: import('e2b').Sandbox,
  localDir: string,
  remoteDir: string,
): Promise<void> => {
  const entries = await readdir(localDir, { withFileTypes: true });
  for (const entry of entries) {
    const localPath = path.join(localDir, entry.name);
    const remotePath = `${remoteDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await sandbox.files.makeDir(remotePath);
      await uploadDirToE2B(sandbox, localPath, remotePath);
    } else if (entry.isFile()) {
      const data = await readFile(localPath);
      // e2b SDK accepts ArrayBuffer | string | Blob | ReadableStream — not Node Buffer.
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await sandbox.files.write(remotePath, buf);
    }
    // Symlinks and other types are skipped.
  }
};

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

  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    // E2B has no host-side mount — files must be pushed through the SDK.
    // If the sandbox is not connected, skip: the dirty state needs to be
    // persisted (TODO: store on the sandboxes table once Step E lands) so
    // the next ensure() can replay the sync. For now, callers who change
    // skills while the sandbox is paused will need to trigger an exec to
    // re-sync. Logged so the gap is visible.
    if (!this.sandbox) {
      console.warn(
        `[exec-backend][e2b][${this.id}] syncSkills called while sandbox not connected — skipping. ` +
          `TODO(step-e): persist dirty manifest on sandboxes table and replay on ensure().`,
      );
      return;
    }

    const remoteSystemDir = `${this.agentHome}/.openhermit/skills/system`;
    // Wipe and recreate. Cheap on e2b given small skill sizes.
    await this.sandbox.commands.run(`rm -rf ${remoteSystemDir} && mkdir -p ${remoteSystemDir}`);

    for (const skill of skills) {
      const remoteSkillDir = `${remoteSystemDir}/${skill.id}`;
      await this.sandbox.files.makeDir(remoteSkillDir);
      await uploadDirToE2B(this.sandbox, skill.sourcePath, remoteSkillDir);
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
    if (!this.context.getRuntimeState) return null;
    const state = await this.context.getRuntimeState();
    return (state?.['e2b'] as E2BBackendPersisted) ?? null;
  }

  private async saveState(persisted: E2BBackendPersisted): Promise<void> {
    if (!this.context.setRuntimeState || !this.context.getRuntimeState) return;
    const current = (await this.context.getRuntimeState()) ?? {};
    await this.context.setRuntimeState({ ...current, e2b: persisted });
  }
}

// ── Register built-in backends ────────────────────────────────────────────

registerExecBackend('docker', (config, context) =>
  new DockerExecBackend(
    config as DockerExecBackendConfig,
    context.containerManager,
    context.agentId,
    context.workspaceDir,
  ),
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

  /**
   * Build from sandbox-store rows. Each row's `alias` becomes the backend
   * id; `config` JSONB becomes the per-backend config (cast to its
   * type-specific shape). The default backend is the row aliased
   * `default`, falling back to the first row.
   */
  static fromSandboxRows(
    rows: ReadonlyArray<{
      id: string;
      alias: string;
      type: string;
      config: Record<string, unknown>;
    }>,
    context: Omit<BackendFactoryContext, 'getRuntimeState' | 'setRuntimeState'>,
    runtimeStateAccess: {
      get: (sandboxId: string) => Promise<Record<string, unknown> | null>;
      set: (sandboxId: string, state: Record<string, unknown>) => Promise<void>;
    },
  ): ExecBackendManager {
    if (rows.length === 0) {
      throw new ValidationError('No sandboxes configured for this agent.');
    }
    const backends = rows.map((row) => {
      const ctx: BackendFactoryContext = {
        ...context,
        getRuntimeState: () => runtimeStateAccess.get(row.id),
        setRuntimeState: (state) => runtimeStateAccess.set(row.id, state),
      };
      const cfg = { ...row.config, type: row.type, id: row.alias } as ExecBackendConfig;
      return createExecBackend(cfg, ctx);
    });
    const defaultId = rows.find((r) => r.alias === 'default')?.alias ?? rows[0]!.alias;
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

  /** Fan out skill sync to every backend. Backends decide how to apply. */
  async syncSkills(skills: SyncSkillEntry[]): Promise<void> {
    for (const backend of this.backends.values()) {
      await backend.syncSkills(skills);
    }
  }
}
