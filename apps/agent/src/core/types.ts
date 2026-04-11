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
}

export interface AgentIdentityConfig {
  files: string[];
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

export interface MemoryConfig {
  checkpoint_turn_interval: number;
}

export interface TelegramBridgeConfig {
  enabled: boolean;
  allowed_chat_ids: string[];
}

export interface ChannelsConfig {
  telegram_bridge: TelegramBridgeConfig;
}

export const DEFAULT_WORKSPACE_IDENTITY_FILES = [
  '.openhermit/IDENTITY.md',
  '.openhermit/SOUL.md',
  '.openhermit/AGENTS.md',
] as const;

export interface WorkspaceContainerConfig {
  image: string;
  memory_limit?: string;
  cpu_shares?: number;
}

export interface AgentRuntimeConfig {
  workspace_root: string;
  model: AgentModelConfig;
  identity: AgentIdentityConfig;
  http_api: HttpApiConfig;
  memory: MemoryConfig;
  workspace_container?: WorkspaceContainerConfig;
}

export type AgentConfig = AgentRuntimeConfig;

export interface WorkspaceConfig {
  plugins?: string[];
  channels: ChannelsConfig;
}

export interface SecurityPolicy {
  autonomy_level: AutonomyLevel;
  require_approval_for: string[];
}

export type SecretsMap = Record<string, string>;

export type ContainerType = 'ephemeral' | 'service' | 'workspace';

export type ContainerStatus =
  | 'created'
  | 'running'
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
  require_approval_for: ['container_start', 'delete_file'],
};
