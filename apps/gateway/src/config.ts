import fs from 'node:fs/promises';

export interface AutoProvisionSandboxConfig {
  enabled: boolean;
  type: 'host' | 'docker' | 'e2b';
  config: Record<string, unknown>;
}

export interface GatewayConfig {
  ui: boolean;
  cors: { origin: string };
  autoStartAgents: boolean;
  autoProvisionSandbox: AutoProvisionSandboxConfig;
}

const DEFAULT_CONFIG: GatewayConfig = {
  ui: true,
  cors: { origin: '*' },
  autoStartAgents: true,
  autoProvisionSandbox: {
    enabled: true,
    type: 'docker',
    config: { image: 'ubuntu:24.04' },
  },
};

const getCorsOrigin = (raw: Record<string, unknown>): string | undefined => {
  if (raw.cors && typeof raw.cors === 'object') {
    const origin = (raw.cors as Record<string, unknown>).origin;
    if (typeof origin === 'string') return origin;
  }
  return undefined;
};

/**
 * Load gateway.json from the given path, merging with defaults.
 * Returns defaults if the file doesn't exist.
 */
export const loadGatewayConfig = async (filePath: string): Promise<GatewayConfig> => {
  let raw: Record<string, unknown> = {};
  try {
    const content = await fs.readFile(filePath, 'utf8');
    raw = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`Failed to read gateway config: ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // File doesn't exist — use defaults
  }

  return {
    ui: typeof raw.ui === 'boolean' ? raw.ui : DEFAULT_CONFIG.ui,
    cors: {
      origin: getCorsOrigin(raw) ?? DEFAULT_CONFIG.cors.origin,
    },
    autoStartAgents: typeof raw.autoStartAgents === 'boolean'
      ? raw.autoStartAgents
      : DEFAULT_CONFIG.autoStartAgents,
    autoProvisionSandbox: getAutoProvisionSandbox(raw) ?? DEFAULT_CONFIG.autoProvisionSandbox,
  };
};

const getAutoProvisionSandbox = (
  raw: Record<string, unknown>,
): AutoProvisionSandboxConfig | undefined => {
  const value = raw['autoProvisionSandbox'];
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const enabled = typeof v['enabled'] === 'boolean' ? v['enabled'] : DEFAULT_CONFIG.autoProvisionSandbox.enabled;
  const type = typeof v['type'] === 'string' ? v['type'] : DEFAULT_CONFIG.autoProvisionSandbox.type;
  if (type !== 'host' && type !== 'docker' && type !== 'e2b') {
    throw new Error(`Invalid autoProvisionSandbox.type: ${type}`);
  }
  const config = (v['config'] && typeof v['config'] === 'object')
    ? (v['config'] as Record<string, unknown>)
    : {};
  return { enabled, type, config };
};
