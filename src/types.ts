export interface AgentPathOptions {
  cloudmindHome?: string;
}

export type AutonomyLevel = 'readonly' | 'supervised' | 'full';

export interface SecurityConfig {
  autonomy_level: AutonomyLevel;
  require_approval_for: string[];
}

export type SecretsMap = Record<string, string>;

export interface WorkspaceConfig {
  agent_id: string;
  name: string;
  created: string;
  model: {
    provider: string;
    model: string;
    max_tokens: number;
  };
  identity: {
    files: string[];
  };
  container_defaults: {
    image_allowlist: string[];
    memory_limit: string;
    cpu_shares: number;
    timeout_seconds: number;
    network: 'disabled';
  };
}

export interface ProcessRunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  onTimeout?: () => void | Promise<void>;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: string | null;
  durationMs: number;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: ProcessRunOptions,
) => Promise<ProcessResult>;

export interface ContainerRunOptions {
  image: string;
  command: string;
  workdir?: string;
  env?: Record<string, string>;
}

export interface ContainerRunPlan {
  image: string;
  command: string;
  containerName: string;
  hostFilesPath: string;
  containerWorkdir: string;
  env: Record<string, string>;
  timeoutMs: number;
  args: string[];
}

export interface ContainerRunResult extends ProcessResult {
  image: string;
  command: string;
  containerName: string;
  hostFilesPath: string;
  containerWorkdir: string;
}
