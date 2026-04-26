import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { AgentRunner } from '@openhermit/agent/agent-runner';
import { AgentSecurity, AgentWorkspace, BUILTIN_CHANNELS } from '@openhermit/agent/core';
import {
  createLangfuseClientFromEnv,
  createLangfuseShutdownHandler,
  type LangfuseClientLike,
} from '@openhermit/agent/langfuse';
import { startChannels, startSingleChannel, stopChannels, type ChannelStatus } from '@openhermit/agent/channels';
import type { AgentConfigStore, McpServerStore, SecretStore, SkillStore } from '@openhermit/store';

import type { ChannelRegistry } from './auth.js';

const log = (message: string): void => {
  console.log(`[openhermit-gateway] ${message}`);
};

interface ChannelHandle {
  name: string;
  stop: () => Promise<void>;
}

export class AgentInstanceManager {
  private runners = new Map<string, AgentRunner>();
  private langfuseClients = new Map<string, LangfuseClientLike>();
  private channelHandles = new Map<string, ChannelHandle[]>();
  private channelStatuses = new Map<string, ChannelStatus[]>();

  /** Gateway base URL used for channel adapters to connect back. */
  private gatewayBaseUrl: string | undefined;
  /** Admin token forwarded to channel adapters for gateway auth. */
  private adminToken: string | undefined;
  /** Shared channel registry for external channel token auth. */
  private channelRegistry: ChannelRegistry | undefined;
  /** Shared skill store for DB-managed skills. */
  private skillStore: SkillStore | undefined;
  /** Shared MCP server store for DB-managed MCP servers. */
  private mcpServerStore: McpServerStore | undefined;
  /** DB-backed agent config + security policy store. */
  private configStore: AgentConfigStore | undefined;
  /** File-backed (today) secret store. */
  private secretStore: SecretStore | undefined;

  setGatewayBaseUrl(url: string): void {
    this.gatewayBaseUrl = url;
  }

  setAdminToken(token: string | undefined): void {
    this.adminToken = token;
  }

  setChannelRegistry(registry: ChannelRegistry): void {
    this.channelRegistry = registry;
  }

  setSkillStore(store: SkillStore): void {
    this.skillStore = store;
  }

  setMcpServerStore(store: McpServerStore): void {
    this.mcpServerStore = store;
  }

  setConfigStore(store: AgentConfigStore): void {
    this.configStore = store;
  }

  setSecretStore(store: SecretStore): void {
    this.secretStore = store;
  }

  getConfigStore(): AgentConfigStore | undefined {
    return this.configStore;
  }

  getSecretStore(): SecretStore | undefined {
    return this.secretStore;
  }


  /**
   * Create and start an in-process AgentRunner for the given agent.
   */
  async start(
    agentId: string,
    workspaceDir: string,
  ): Promise<AgentRunner> {
    if (this.runners.has(agentId)) {
      throw new Error(`AgentRunner for "${agentId}" is already running.`);
    }

    // 1. Workspace
    const workspace = new AgentWorkspace(workspaceDir);
    log(`[${agentId}] initialising workspace: ${workspaceDir}`);
    await workspace.init({ agentId });

    if (!this.configStore || !this.secretStore) {
      throw new Error(
        'AgentInstanceManager requires configStore and secretStore (call setConfigStore/setSecretStore at startup).',
      );
    }

    // 2. Security — local data dir (skill-mounts, runtime.json) lives at
    //    OPENHERMIT_HOME/agents/<agentId>; AgentSecurity derives it.
    const security = new AgentSecurity({
      agentId,
      workspace,
      configStore: this.configStore,
      secretStore: this.secretStore,
    });
    await security.init();
    await security.load();

    // 3. Reconcile workspace_root in the persisted config
    const initialConfig = await security.readConfig();
    if (initialConfig.workspace_root !== workspaceDir) {
      await security.writeConfig({
        ...initialConfig,
        workspace_root: workspaceDir,
      });
    }

    log(`[${agentId}] autonomy: ${security.getAutonomyLevel()}`);

    // 4. Optional Langfuse tracing
    const langfuse = createLangfuseClientFromEnv({ logger: log });
    if (langfuse) {
      this.langfuseClients.set(agentId, langfuse);
      log(`[${agentId}] Langfuse tracing enabled`);
    }

    // 5. Create the runner
    const runner = await AgentRunner.create({
      workspace,
      security,
      ...(langfuse ? { langfuse } : {}),
      ...(this.skillStore ? { skillStore: this.skillStore } : {}),
      ...(this.mcpServerStore ? { mcpServerStore: this.mcpServerStore } : {}),
    });

    this.runners.set(agentId, runner);
    log(`[${agentId}] runner started`);

    // 6. Register channel tokens for external channel auth.
    if (this.channelRegistry) {
      const channelTokens = security.getChannelTokens();
      for (const entry of channelTokens) {
        const channelId = `${agentId}:${entry.channel}`;
        this.channelRegistry.register({
          channelId,
          apiKey: entry.token,
          namespace: entry.channel,
          agentId,
        });
        log(`[${agentId}] registered channel token: ${entry.channel}`);
      }
    }

    // 7. Start built-in channel adapters (e.g. Telegram) if configured.
    //    Each built-in channel gets an auto-generated token registered in the
    //    ChannelRegistry, scoped to this agent and channel namespace.
    if (this.gatewayBaseUrl) {
      try {
        const config = await security.readConfig();
        if (config.channels) {
          const agentBaseUrl = `${this.gatewayBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;

          // Generate a per-channel token so each builtin channel gets its own auth identity.
          const enabledBuiltins = BUILTIN_CHANNELS.filter(
            (def) => (config.channels as Record<string, { enabled?: boolean }>)[def.key]?.enabled,
          );
          const agentTokens: Record<string, string> = {};
          for (const def of enabledBuiltins) {
            const token = randomBytes(24).toString('hex');
            agentTokens[def.key] = token;
            if (this.channelRegistry) {
              this.channelRegistry.register({
                channelId: `${agentId}:${def.key}:builtin`,
                apiKey: token,
                namespace: def.namespace,
                agentId,
              });
            }
          }

          const { handles, statuses } = await startChannels(config.channels, {
            agentBaseUrl,
            agentTokens,
            logger: (channel, msg) => log(`[${agentId}] [${channel}] ${msg}`),
          });
          if (statuses.length > 0) {
            this.channelStatuses.set(agentId, statuses);
          }
          if (handles.length > 0) {
            this.channelHandles.set(agentId, handles);
            for (const handle of handles) {
              if (handle.outbound) {
                runner.registerChannelOutbound(handle.outbound);
              }
            }
            log(`[${agentId}] started ${handles.length} channel(s): ${handles.map((h) => h.name).join(', ')}`);
          }
        }
      } catch (error) {
        log(`[${agentId}] failed to start channels: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 8. Start the scheduler for cron/once jobs.
    try {
      await runner.startScheduler();
    } catch (error) {
      log(`[${agentId}] failed to start scheduler: ${error instanceof Error ? error.message : String(error)}`);
    }

    return runner;
  }

  /** Retrieve a running AgentRunner by agent ID, if one exists. */
  getRunner(agentId: string): AgentRunner | undefined {
    return this.runners.get(agentId);
  }

  getChannelStatuses(agentId: string): ChannelStatus[] {
    return this.channelStatuses.get(agentId) ?? [];
  }

  async stopSingleChannel(agentId: string, channelName: string, log: (msg: string) => void): Promise<void> {
    const handles = this.channelHandles.get(agentId) ?? [];
    const idx = handles.findIndex((h) => h.name === channelName);
    if (idx !== -1) {
      const handle = handles[idx]!;
      try {
        await handle.stop();
      } catch (err) {
        log(`[${agentId}] error stopping ${channelName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      handles.splice(idx, 1);
      if (handles.length === 0) this.channelHandles.delete(agentId);

      const runner = this.runners.get(agentId);
      if (runner) {
        runner.getChannelOutbound().delete(channelName);
      }
    }

    if (this.channelRegistry) {
      this.channelRegistry.unregister(`${agentId}:${channelName}:builtin`);
    }

    const statuses = this.channelStatuses.get(agentId) ?? [];
    const sIdx = statuses.findIndex((s) => s.name === channelName);
    if (sIdx !== -1) statuses.splice(sIdx, 1);

    log(`[${agentId}] stopped channel: ${channelName}`);
  }

  async startSingleChannel(agentId: string, channelName: string, log: (msg: string) => void): Promise<ChannelStatus> {
    const runner = this.runners.get(agentId);
    if (!runner || !this.gatewayBaseUrl) {
      return { name: channelName, status: 'error', error: 'Agent not running' };
    }

    const config = await runner.security.readConfig();
    if (!config.channels) {
      return { name: channelName, status: 'error', error: 'No channels configured' };
    }

    const agentBaseUrl = `${this.gatewayBaseUrl}/api/agents/${encodeURIComponent(agentId)}`;
    const token = randomBytes(24).toString('hex');
    if (this.channelRegistry) {
      this.channelRegistry.register({
        channelId: `${agentId}:${channelName}:builtin`,
        apiKey: token,
        namespace: channelName,
        agentId,
      });
    }

    const { handle, status } = await startSingleChannel(channelName, config.channels, {
      agentBaseUrl,
      agentTokens: { [channelName]: token },
      logger: (channel, msg) => log(`[${agentId}] [${channel}] ${msg}`),
    });

    if (handle) {
      const handles = this.channelHandles.get(agentId) ?? [];
      handles.push(handle);
      this.channelHandles.set(agentId, handles);
      if (handle.outbound) {
        runner.registerChannelOutbound(handle.outbound);
      }
      log(`[${agentId}] started channel: ${channelName}`);
    }

    const statuses = this.channelStatuses.get(agentId) ?? [];
    const existingIdx = statuses.findIndex((s) => s.name === channelName);
    if (existingIdx !== -1) {
      statuses[existingIdx] = status;
    } else {
      statuses.push(status);
    }
    this.channelStatuses.set(agentId, statuses);

    return status;
  }

  /** Get all running agent IDs. */
  getRunningAgentIds(): string[] {
    return [...this.runners.keys()];
  }

  /** List all running agent IDs. */
  listRunnerIds(): string[] {
    return [...this.runners.keys()];
  }

  /** Stop a single agent, flushing Langfuse and cleaning up resources. */
  async stop(agentId: string): Promise<void> {
    const runner = this.runners.get(agentId);
    if (!runner) {
      return;
    }

    // Unregister channel tokens.
    this.channelRegistry?.unregisterByAgent(agentId);

    // Stop channels first.
    const handles = this.channelHandles.get(agentId);
    if (handles) {
      await stopChannels(handles);
      this.channelHandles.delete(agentId);
    }
    this.channelStatuses.delete(agentId);

    await runner.shutdown();

    const langfuse = this.langfuseClients.get(agentId);
    if (langfuse) {
      const shutdown = createLangfuseShutdownHandler(langfuse);
      await shutdown();
      this.langfuseClients.delete(agentId);
    }

    this.runners.delete(agentId);
    log(`[${agentId}] runner stopped`);
  }

  /** Stop every managed agent. */
  async stopAll(): Promise<void> {
    const ids = [...this.runners.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
