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
