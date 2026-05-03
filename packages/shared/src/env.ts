import { readFile, rename, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const parseEnvFile = (content: string): Map<string, string> => {
  const vars = new Map<string, string>();

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7) : line;
    const eq = normalized.indexOf('=');
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    if (!key) continue;

    let value = normalized.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/gu, '\n');

    vars.set(key, value);
  }

  return vars;
};

const tryLoadFile = async (filePath: string): Promise<Map<string, string>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return parseEnvFile(content);
  } catch {
    return new Map();
  }
};

export const resolveOpenHermitHome = (): string =>
  process.env['OPENHERMIT_HOME'] || path.join(homedir(), '.openhermit');

/**
 * Gateway-owned subdirectory: gateway.json, .env, *.log, *.pid, and
 * future registry files. Keeps gateway state separate from per-agent
 * data and from host-backend agent metadata.
 */
export const resolveGatewayDir = (): string =>
  path.join(resolveOpenHermitHome(), 'gateway');

/**
 * Per-agent local-data directory, used for skill-mount symlinks. Config,
 * security policy, and secrets all live in the database now, so this
 * path is purely derivable from the agent id and OPENHERMIT_HOME — no
 * longer stored on the agents row.
 */
export const resolveAgentDataDir = (agentId: string): string =>
  path.join(resolveOpenHermitHome(), 'agents', agentId);

/**
 * Load environment variables from ~/.openhermit/gateway/.env (with a
 * fallback to the legacy ~/.openhermit/.env for users who have not yet
 * been migrated).
 *
 * Already-set process.env values are never overwritten.
 * Returns the number of new variables set.
 */
export const loadEnv = async (): Promise<number> => {
  const home = resolveOpenHermitHome();
  const gatewayEnv = path.join(home, 'gateway', '.env');
  const legacyEnv = path.join(home, '.env');

  let vars = await tryLoadFile(gatewayEnv);
  if (vars.size === 0) {
    vars = await tryLoadFile(legacyEnv);
  }

  let loaded = 0;
  for (const [key, value] of vars) {
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded += 1;
    }
  }

  return loaded;
};

const LEGACY_GATEWAY_FILES = [
  'gateway.json',
  'gateway.log',
  'gateway.pid',
  'web.log',
  'web.pid',
  '.env',
] as const;

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * One-time migration: move gateway state files from `~/.openhermit/foo`
 * into `~/.openhermit/gateway/foo`, and the legacy system-skills source
 * dir `~/.openhermit/skills/` into `~/.openhermit/gateway/registry/skills/`.
 *
 * Safe to call multiple times — if the destination already exists or
 * the source is missing, the entry is skipped. Called eagerly from
 * gateway and CLI startup paths.
 *
 * Returns the list of entries actually moved (for logging).
 */
export const migrateLegacyGatewayLayout = async (): Promise<string[]> => {
  const home = resolveOpenHermitHome();
  const gatewayDir = path.join(home, 'gateway');
  const moved: string[] = [];

  if (!(await exists(home))) return moved;

  await mkdir(gatewayDir, { recursive: true });

  for (const name of LEGACY_GATEWAY_FILES) {
    const src = path.join(home, name);
    const dst = path.join(gatewayDir, name);
    if (!(await exists(src))) continue;
    if (await exists(dst)) continue;
    try {
      await rename(src, dst);
      moved.push(name);
    } catch {
      // Best-effort: if rename fails (e.g. cross-device, perms) we leave
      // the legacy file in place. loadEnv falls back to the legacy path.
    }
  }

  // Legacy ~/.openhermit/skills/ → ~/.openhermit/gateway/registry/skills/
  // (registry source for system-installed skill packages).
  const legacySkills = path.join(home, 'skills');
  const newRegistrySkills = path.join(gatewayDir, 'registry', 'skills');
  if ((await exists(legacySkills)) && !(await exists(newRegistrySkills))) {
    try {
      await mkdir(path.dirname(newRegistrySkills), { recursive: true });
      await rename(legacySkills, newRegistrySkills);
      moved.push('skills/');
    } catch {
      // Best-effort.
    }
  }

  return moved;
};
