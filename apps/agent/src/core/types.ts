/**
 * Path inside the agent's exec container/sandbox where the host workspace
 * dir is mounted (docker) or where the working directory lives (e2b).
 * Aligns with E2B's default user home (`/home/user`) so e2b sandboxes can
 * use their natural filesystem layout, and so docker containers feel like
 * the agent's "home" rather than a generic /workspace mount.
 */
export const AGENT_CONTAINER_HOME = '/home/user';

export type HookPoint =
  | 'onSessionStart'
  | 'onSessionEnd'
  | 'beforeInbound'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'beforeOutbound'
  | 'onScheduleTrigger'
  | 'onError';

export type AutonomyLevel = 'readonly' | 'supervised' | 'full';

export interface AgentModelConfig {
  provider: string;
  model: string;
  max_tokens: number;
  /** Override the default base URL for the provider (e.g. domestic Chinese endpoint). */
  base_url?: string;
  /**
   * API protocol to use. Required when defining a fully custom model with base_url
   * that is not in the pi-ai registry. Common values: 'openai-completions', 'anthropic-messages'.
   */
  api?: string;
  thinking?: ThinkingLevel;
}

export interface ContainerDefaultsConfig {
  memory_limit: string;
  cpu_shares: number;
  network: string;
}

export interface IntrospectionConfig {
  enabled: boolean;
  turn_interval: number;
  passive_turn_interval: number;
  idle_timeout_minutes: number;
  max_tool_calls: number;
  model: string | null;
}

export const DEFAULT_INTROSPECTION_CONFIG: IntrospectionConfig = {
  enabled: true,
  turn_interval: 5,
  passive_turn_interval: 20,
  idle_timeout_minutes: 10,
  max_tool_calls: 10,
  model: null,
};

export interface MemoryConfig {
  context_entry_limit?: number | undefined;
  introspection?: IntrospectionConfig | undefined;
}

export interface TelegramChannelConfig {
  enabled: boolean;
  bot_token: string;
  mode?: 'polling' | 'webhook';
  webhook_url?: string;
  webhook_port?: number;
  allowed_chat_ids?: string[];
}

export interface SlackChannelConfig {
  enabled: boolean;
  bot_token: string;
  app_token: string;
  allowed_channel_ids?: string[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  bot_token: string;
  allowed_channel_ids?: string[];
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
  slack?: SlackChannelConfig;
  discord?: DiscordChannelConfig;
}

/**
 * Built-in channel definitions. Each entry maps a ChannelsConfig key to the
 * identity namespace the channel bridge uses in `sender.channel`.
 * When adding a new built-in channel, add an entry here.
 */
export const BUILTIN_CHANNELS: readonly BuiltinChannelDef[] = [
  { key: 'telegram', namespace: 'telegram' },
  { key: 'slack', namespace: 'slack' },
  { key: 'discord', namespace: 'discord' },
] satisfies readonly { key: keyof ChannelsConfig; namespace: string }[];

export interface BuiltinChannelDef {
  /** Key in ChannelsConfig. */
  key: keyof ChannelsConfig;
  /** Identity namespace used by the bridge in sender.channel. */
  namespace: string;
}

export type WorkspaceContainerStartPolicy = 'session' | 'ondemand';
export type WorkspaceContainerStopPolicy = 'session' | 'idle';

export interface WorkspaceContainerLifecycle {
  start?: WorkspaceContainerStartPolicy;
  stop?: WorkspaceContainerStopPolicy;
  idle_timeout_minutes?: number;
}

export interface WorkspaceContainerConfig {
  image: string;
  memory_limit?: string;
  cpu_shares?: number;
  lifecycle?: WorkspaceContainerLifecycle;
  /** Host directory containing skill symlinks, mounted read-only at /skills in the container. */
  skillMountsDir?: string;
}

export type WebProviderName = 'defuddle' | 'exa' | 'tavily';

export interface WebConfig {
  provider: WebProviderName;
}

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface AgentRuntimeConfig {
  workspace_root: string;
  model: AgentModelConfig;
  memory: MemoryConfig;
  exec?: import('./exec-backend.js').ExecConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
}

export type AgentConfig = AgentRuntimeConfig;

/**
 * Build the default config.json content for a freshly-created agent.
 * Used by both the gateway's POST /agents endpoint and the agent's
 * security init fallback so a new agent is never written with a
 * minimal stub.
 */
export const buildDefaultAgentConfig = (workspaceRoot: string): AgentRuntimeConfig => ({
  workspace_root: workspaceRoot,
  model: {
    provider: 'openrouter',
    model: 'google/gemini-3-flash-preview',
    max_tokens: 8192,
  },
  exec: {
    backends: [{ type: 'docker', image: 'ubuntu:24.04' }],
    lifecycle: {
      start: 'ondemand',
      stop: 'idle',
      idle_timeout_minutes: 30,
    },
  },
  web: { provider: 'defuddle' },
  channels: {},
  memory: {
    introspection: { ...DEFAULT_INTROSPECTION_CONFIG },
  },
});

/**
 * Per-agent access policy. Controls who can interact with this agent.
 *
 * - `public` (default): any unknown channel sender is auto-promoted to a
 *   guest member on first message. Demo/open-bot deployments.
 * - `protected`: unknown senders are rejected unless they self-join via
 *   `POST /api/agents/:id/members` with the agent's `access_token`. No
 *   auto-guest creation.
 * - `private`: only owner/admin-added members can interact. accessToken
 *   self-join is also disabled.
 */
export type AgentAccessLevel = 'public' | 'protected' | 'private';

export interface ChannelTokenEntry {
  /** Channel namespace, e.g. "telegram", "discord", "custom-bot". */
  channel: string;
  /** Pre-shared API key for this channel. */
  token: string;
}

export interface SecurityPolicy {
  autonomy_level: AutonomyLevel;
  require_approval_for: string[];
  access?: AgentAccessLevel;
  access_token?: string;
  /** Per-channel API tokens for external channel adapters. */
  channel_tokens?: ChannelTokenEntry[];
}

export type SecretsMap = Record<string, string>;

export type ContainerType = 'workspace';

export type ContainerStatus =
  | 'created'
  | 'running'
  | 'stopped'
  | 'exited'
  | 'removed'
  | 'unknown';

export interface ContainerRegistryEntry {
  id: string;
  name: string;
  image: string;
  type: ContainerType;
  status: ContainerStatus;
  description?: string;
  command?: string;
  ports?: Record<string, number>;
  mount?: string;
  mount_target?: string;
  network?: string;
  runtime_container_id?: string;
  exit_code?: number;
  created: string;
  removed?: string;
}

export interface ContainerProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  parsedOutput?: unknown;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  autonomy_level: 'supervised',
  require_approval_for: [],
};
