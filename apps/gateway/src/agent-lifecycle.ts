import { type ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeStateFile } from '@openhermit/shared';

import { AgentRegistry, type AgentRegistryEntry } from './agent-registry.js';

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const STARTUP_POLL_INTERVAL_MS = 500;
const STARTUP_TIMEOUT_MS = 30_000;

export interface AgentLifecycleOptions {
  registry: AgentRegistry;
  logger?: (message: string) => void;
  /** Override for testing — path to the agent entry script. */
  agentEntryPath?: string;
}

const resolveRuntimeJsonPath = (agentId: string): string => {
  const baseDir =
    process.env.OPENHERMIT_HOME ?? path.join(os.homedir(), '.openhermit');
  return path.join(baseDir, agentId, 'runtime.json');
};

const readRuntimeJson = async (
  agentId: string,
): Promise<RuntimeStateFile | undefined> => {
  try {
    const content = await fs.readFile(resolveRuntimeJsonPath(agentId), 'utf8');
    return JSON.parse(content) as RuntimeStateFile;
  } catch {
    return undefined;
  }
};

const waitForRuntimeJson = async (
  agentId: string,
  timeoutMs: number,
): Promise<RuntimeStateFile | undefined> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const runtime = await readRuntimeJson(agentId);

    if (runtime) {
      return runtime;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, STARTUP_POLL_INTERVAL_MS),
    );
  }

  return undefined;
};

export class AgentLifecycle {
  private readonly registry: AgentRegistry;
  private readonly log: (message: string) => void;
  private readonly agentEntryPath: string;
  private readonly processes = new Map<string, ChildProcess>();

  constructor(options: AgentLifecycleOptions) {
    this.registry = options.registry;
    this.log = options.logger ?? ((msg: string) => console.log(msg));
    this.agentEntryPath =
      options.agentEntryPath ??
      path.resolve(
        import.meta.dirname ?? process.cwd(),
        '../../agent/src/index.ts',
      );
  }

  /**
   * Check if an agent is already running externally (via runtime.json + health check).
   * Does NOT spawn a new process — only updates registry if the agent is alive.
   */
  async discover(agentId: string): Promise<AgentRegistryEntry | undefined> {
    const entry = this.registry.get(agentId);

    if (!entry) {
      return undefined;
    }

    const runtime = await readRuntimeJson(agentId);

    if (!runtime) {
      return undefined;
    }

    const alive = await this.checkHealthHttp(
      runtime.http_api.port,
      runtime.http_api.token,
    );

    if (!alive) {
      return undefined;
    }

    this.registry.update(agentId, {
      status: 'running',
      port: runtime.http_api.port,
    });

    return this.registry.get(agentId)!;
  }

  async start(agentId: string): Promise<AgentRegistryEntry> {
    const entry = this.registry.get(agentId);

    if (!entry) {
      throw new Error(`Agent not registered: ${agentId}`);
    }

    if (entry.status === 'running') {
      return entry;
    }

    // Check if already running externally (runtime.json exists).
    const existingRuntime = await readRuntimeJson(agentId);

    if (existingRuntime) {
      const alive = await this.checkHealthHttp(existingRuntime.http_api.port, existingRuntime.http_api.token);

      if (alive) {
        this.registry.update(agentId, {
          status: 'running',
          port: existingRuntime.http_api.port,
        });
        this.log(
          `[gateway] agent ${agentId} already running on port ${existingRuntime.http_api.port}`,
        );
        return this.registry.get(agentId)!;
      }

      // Stale runtime.json — remove it so the agent can start fresh.
      await fs.rm(resolveRuntimeJsonPath(agentId), { force: true });
    }

    this.registry.update(agentId, { status: 'starting' });
    this.registry.clearError(agentId);
    this.log(`[gateway] starting agent ${agentId}`);

    const args = ['--agent-id', agentId];

    if (entry.port !== undefined) {
      args.push('--port', String(entry.port));
    }

    const child = spawn('tsx', [this.agentEntryPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENHERMIT_AGENT_ID: agentId,
        ...(entry.workspaceRoot
          ? { OPENHERMIT_WORKSPACE_ROOT: entry.workspaceRoot }
          : {}),
      },
      detached: false,
    });

    this.processes.set(agentId, child);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();

      if (text) {
        this.log(`[agent:${agentId}:stdout] ${text}`);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();

      if (text) {
        this.log(`[agent:${agentId}:stderr] ${text}`);
      }
    });

    child.on('exit', (code, signal) => {
      this.processes.delete(agentId);
      const current = this.registry.get(agentId);

      if (current && current.status !== 'stopped') {
        this.registry.update(agentId, {
          status: 'error',
          error: `Process exited with ${signal ? `signal ${signal}` : `code ${code}`}`,
        });
        this.registry.clearRuntime(agentId);
      }

      this.log(
        `[gateway] agent ${agentId} exited (code=${code}, signal=${signal})`,
      );
    });

    if (child.pid !== undefined) {
      this.registry.update(agentId, { pid: child.pid });
    }

    // Wait for runtime.json to appear (agent writes it after binding).
    const runtime = await waitForRuntimeJson(agentId, STARTUP_TIMEOUT_MS);

    if (!runtime) {
      this.registry.update(agentId, {
        status: 'error',
        error: 'Timed out waiting for agent to start',
      });
      throw new Error(
        `Agent ${agentId} did not produce runtime.json within ${STARTUP_TIMEOUT_MS}ms`,
      );
    }

    this.registry.update(agentId, {
      status: 'running',
      port: runtime.http_api.port,
    });

    this.log(
      `[gateway] agent ${agentId} running on port ${runtime.http_api.port}`,
    );

    return this.registry.get(agentId)!;
  }

  async stop(agentId: string): Promise<void> {
    const entry = this.registry.get(agentId);

    if (!entry) {
      throw new Error(`Agent not registered: ${agentId}`);
    }

    const child = this.processes.get(agentId);

    if (child) {
      child.kill('SIGTERM');

      // Give the process a moment to clean up.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5_000);

        child.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });

      this.processes.delete(agentId);
    }

    this.registry.update(agentId, { status: 'stopped' });
    this.registry.clearRuntime(agentId);
    this.registry.clearError(agentId);

    this.log(`[gateway] agent ${agentId} stopped`);
  }

  async restart(agentId: string): Promise<AgentRegistryEntry> {
    await this.stop(agentId);
    return this.start(agentId);
  }

  async healthCheck(agentId: string): Promise<boolean> {
    const entry = this.registry.get(agentId);

    if (!entry || entry.status !== 'running' || !entry.port) {
      return false;
    }

    const runtime = await readRuntimeJson(agentId);

    if (!runtime) {
      return false;
    }

    return this.checkHealthHttp(runtime.http_api.port, runtime.http_api.token);
  }

  async stopAll(): Promise<void> {
    const agents = this.registry.list().filter((a) => a.status === 'running');

    await Promise.all(agents.map((a) => this.stop(a.agentId)));
  }

  getAgentToken(agentId: string): Promise<string | undefined> {
    return readRuntimeJson(agentId).then((r) => r?.http_api.token);
  }

  private async checkHealthHttp(
    port: number,
    token: string,
  ): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS,
      );

      const response = await fetch(`http://localhost:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      clearTimeout(timer);
      return response.ok;
    } catch {
      return false;
    }
  }
}
