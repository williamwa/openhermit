import fs from 'node:fs/promises';

export interface SandboxPreset {
  type: 'host' | 'docker' | 'e2b' | 'daytona';
  /** Backend-specific config (image/snapshot/template, agent_home, etc.). */
  config: Record<string, unknown>;
}

export interface GatewayConfig {
  ui: boolean;
  cors: { origin: string };
  autoStartAgents: boolean;
  /** Named sandbox presets, keyed by preset name. */
  sandboxPresets: Record<string, SandboxPreset>;
  /**
   * Name of the preset to auto-provision when an agent is created without an
   * explicit `sandbox` field. `null` (or missing) disables auto-provisioning.
   */
  autoProvisionSandbox: string | null;
}

const DEFAULT_PRESETS: Record<string, SandboxPreset> = {
  'docker-ubuntu': {
    type: 'docker',
    config: { image: 'ubuntu:24.04', username: 'root', agent_home: '/root' },
  },
};

const DEFAULT_CONFIG: GatewayConfig = {
  ui: true,
  cors: { origin: '*' },
  autoStartAgents: true,
  sandboxPresets: DEFAULT_PRESETS,
  autoProvisionSandbox: 'docker-ubuntu',
};

const SUPPORTED_TYPES = new Set(['host', 'docker', 'e2b', 'daytona']);

const getCorsOrigin = (raw: Record<string, unknown>): string | undefined => {
  if (raw.cors && typeof raw.cors === 'object') {
    const origin = (raw.cors as Record<string, unknown>).origin;
    if (typeof origin === 'string') return origin;
  }
  return undefined;
};

const parsePresets = (raw: unknown): Record<string, SandboxPreset> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, SandboxPreset> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') {
      throw new Error(`Invalid sandboxPresets["${name}"]: must be an object`);
    }
    const v = val as Record<string, unknown>;
    const type = v['type'];
    if (typeof type !== 'string' || !SUPPORTED_TYPES.has(type)) {
      throw new Error(`Invalid sandboxPresets["${name}"].type: ${String(type)}`);
    }
    const config = v['config'] && typeof v['config'] === 'object' && !Array.isArray(v['config'])
      ? (v['config'] as Record<string, unknown>)
      : {};
    out[name] = { type: type as SandboxPreset['type'], config };
  }
  return out;
};

const parseAutoProvision = (
  raw: unknown,
  presets: Record<string, SandboxPreset>,
): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new Error(
      'autoProvisionSandbox must be a string preset name (or null). ' +
        'The legacy { enabled, type, config } shape is no longer supported — ' +
        'move the config into `sandboxPresets` and reference it by name.',
    );
  }
  if (!presets[raw]) {
    throw new Error(
      `autoProvisionSandbox references unknown preset "${raw}". ` +
        `Known presets: ${Object.keys(presets).join(', ') || '(none)'}`,
    );
  }
  return raw;
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

  const presets = parsePresets(raw['sandboxPresets']) ?? DEFAULT_CONFIG.sandboxPresets;
  const autoProvision = 'autoProvisionSandbox' in raw
    ? parseAutoProvision(raw['autoProvisionSandbox'], presets)
    : DEFAULT_CONFIG.autoProvisionSandbox;

  return {
    ui: typeof raw.ui === 'boolean' ? raw.ui : DEFAULT_CONFIG.ui,
    cors: {
      origin: getCorsOrigin(raw) ?? DEFAULT_CONFIG.cors.origin,
    },
    autoStartAgents: typeof raw.autoStartAgents === 'boolean'
      ? raw.autoStartAgents
      : DEFAULT_CONFIG.autoStartAgents,
    sandboxPresets: presets,
    autoProvisionSandbox: autoProvision,
  };
};
