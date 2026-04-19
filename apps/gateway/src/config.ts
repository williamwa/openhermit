import fs from 'node:fs/promises';

export interface GatewayConfig {
  ui: boolean;
  cors: { origin: string };
  autoStartAgents: boolean;
}

const DEFAULT_CONFIG: GatewayConfig = {
  ui: true,
  cors: { origin: '*' },
  autoStartAgents: true,
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
  };
};
