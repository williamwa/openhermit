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
}

export interface ContainerDefaultsConfig {
  memory_limit: string;
  cpu_shares: number;
  network: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  interval_minutes: number;
  max_iterations: number;
  tools_allowed: string[];
}

export interface ScheduleJobConfig {
  id: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  tools_allowed: string[];
}

export interface SchedulesConfig {
  jobs: ScheduleJobConfig[];
}

export interface HttpApiConfig {
  preferred_port: number;
}

export interface IntrospectionConfig {
  enabled: boolean;
  turn_interval: number;
  idle_timeout_minutes: number;
  max_tool_calls: number;
  model: string | null;
}

export const DEFAULT_INTROSPECTION_CONFIG: IntrospectionConfig = {
  enabled: true,
  turn_interval: 5,
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

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
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
}

export type WebProviderName = 'defuddle' | 'exa' | 'tavily';

export interface WebConfig {
  provider: WebProviderName;
}

export interface AgentRuntimeConfig {
  workspace_root: string;
  model: AgentModelConfig;
  http_api: HttpApiConfig;
  memory: MemoryConfig;
  workspace_container?: WorkspaceContainerConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
}

export type AgentConfig = AgentRuntimeConfig;

export interface SecurityPolicy {
  autonomy_level: AutonomyLevel;
  require_approval_for: string[];
}

export type SecretsMap = Record<string, string>;

export type ContainerType = 'ephemeral' | 'service' | 'workspace';

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

export interface EphemeralContainerArgs {
  image: string;
  command: string;
  description?: string;
  mount?: string;
  mount_target?: string;
  env?: Record<string, string>;
  workdir?: string;
}

export interface ServiceContainerArgs {
  image: string;
  name: string;
  description?: string;
  mount?: string;
  mount_target?: string;
  ports?: Record<string, number>;
  env?: Record<string, string>;
  network?: string;
}

export interface ContainerListEntry extends ContainerRegistryEntry {
  live_status_text?: string;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  autonomy_level: 'supervised',
  require_approval_for: ['container_start'],
};
