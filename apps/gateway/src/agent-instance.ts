import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { AgentRunner } from '@openhermit/agent/agent-runner';
import { AgentSecurity, AgentWorkspace, BUILTIN_CHANNELS } from '@openhermit/agent/core';
import {
  createLangfuseClientFromEnv,
  createLangfuseShutdownHandler,
  type LangfuseClientLike,
} from '@openhermit/agent/langfuse';
import { startChannels, stopChannels } from '@openhermit/agent/channels';

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

  /** Gateway base URL used for channel adapters to connect back. */
  private gatewayBaseUrl: string | undefined;
  /** Admin token forwarded to channel adapters for gateway auth. */
  private adminToken: string | undefined;
  /** Shared channel registry for external channel token auth. */
  private channelRegistry: ChannelRegistry | undefined;

  setGatewayBaseUrl(url: string): void {
    this.gatewayBaseUrl = url;
  }

  setAdminToken(token: string | undefined): void {
    this.adminToken = token;
  }

  setChannelRegistry(registry: ChannelRegistry): void {
    this.channelRegistry = registry;
  }

  /**
   * Create and start an in-process AgentRunner for the given agent.
   */
  async start(
    agentId: string,
    configDir: string,
    workspaceDir: string,
  ): Promise<AgentRunner> {
    if (this.runners.has(agentId)) {
      throw new Error(`AgentRunner for "${agentId}" is already running.`);
    }

    // 1. Workspace
    const workspace = new AgentWorkspace(workspaceDir);
    log(`[${agentId}] initialising workspace: ${workspaceDir}`);
    await workspace.init({ agentId });

    // 2. Security (config dir is the parent of the per-agent directory)
    const security = new AgentSecurity({
      agentId,
      workspace,
      openHermitHome: path.dirname(configDir),
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
          const agentBaseUrl = `${this.gatewayBaseUrl}/agents/${encodeURIComponent(agentId)}`;

          // Generate a per-agent token for built-in channels and register it.
          const builtinToken = randomBytes(24).toString('hex');
          const enabledBuiltins = BUILTIN_CHANNELS.filter(
            (def) => (config.channels as Record<string, { enabled?: boolean }>)[def.key]?.enabled,
          );
          if (this.channelRegistry) {
            for (const def of enabledBuiltins) {
              this.channelRegistry.register({
                channelId: `${agentId}:${def.key}:builtin`,
                apiKey: builtinToken,
                namespace: def.namespace,
                agentId,
              });
            }
          }

          const handles = await startChannels(config.channels, {
            agentBaseUrl,
            agentToken: builtinToken,
            logger: (msg) => log(`[${agentId}] [telegram] ${msg}`),
          });
          if (handles.length > 0) {
            this.channelHandles.set(agentId, handles);
            // Register outbound adapters on the runner so tools can send messages.
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

    return runner;
  }

  /** Retrieve a running AgentRunner by agent ID, if one exists. */
  getRunner(agentId: string): AgentRunner | undefined {
    return this.runners.get(agentId);
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

    await runner.stopWorkspaceContainerIfSessionPolicy();

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
