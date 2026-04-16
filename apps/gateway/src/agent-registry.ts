import type { AgentStatus, AgentInfo } from '@openhermit/protocol';

export interface AgentRegistryEntry {
  agentId: string;
  name?: string;
  configDir?: string;
  workspaceDir?: string;
  status: AgentStatus;
  port?: number;
  pid?: number;
  error?: string;
  config?: Record<string, unknown>;
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRegistryEntry>();

  register(agentId: string, config?: {
    name?: string;
    configDir?: string;
    workspaceDir?: string;
    port?: number;
    config?: Record<string, unknown>;
  }): AgentRegistryEntry {
    const existing = this.agents.get(agentId);

    if (existing) {
      if (config?.name !== undefined) existing.name = config.name;
      if (config?.configDir !== undefined) existing.configDir = config.configDir;
      if (config?.workspaceDir !== undefined) existing.workspaceDir = config.workspaceDir;
      if (config?.port !== undefined) existing.port = config.port;
      if (config?.config !== undefined) existing.config = config.config;
      return existing;
    }

    const entry: AgentRegistryEntry = {
      agentId,
      status: 'registered',
      ...config,
    };

    this.agents.set(agentId, entry);
    return entry;
  }

  get(agentId: string): AgentRegistryEntry | undefined {
    return this.agents.get(agentId);
  }

  list(): AgentRegistryEntry[] {
    return [...this.agents.values()];
  }

  update(agentId: string, patch: Partial<Omit<AgentRegistryEntry, 'agentId'>>): AgentRegistryEntry | undefined {
    const entry = this.agents.get(agentId);

    if (!entry) {
      return undefined;
    }

    Object.assign(entry, patch);
    return entry;
  }

  clearRuntime(agentId: string): void {
    const entry = this.agents.get(agentId);

    if (entry) {
      delete entry.port;
      delete entry.pid;
    }
  }

  clearError(agentId: string): void {
    const entry = this.agents.get(agentId);

    if (entry) {
      delete entry.error;
    }
  }

  remove(agentId: string): boolean {
    return this.agents.delete(agentId);
  }

  toAgentInfo(entry: AgentRegistryEntry): AgentInfo {
    return {
      agentId: entry.agentId,
      status: entry.status,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.configDir ? { configDir: entry.configDir } : {}),
      ...(entry.workspaceDir ? { workspaceDir: entry.workspaceDir } : {}),
      ...(entry.port !== undefined ? { port: entry.port } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    };
  }
}
