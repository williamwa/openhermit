import { readFile } from 'node:fs/promises';
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
 * Per-agent local-data directory, used for things that still legitimately
 * live on disk (skill-mount symlinks, runtime.json). Config / security
 * policy / secrets are all in the database now, so this path is purely
 * derivable from the agent id and OPENHERMIT_HOME — no longer stored on
 * the agents row.
 */
export const resolveAgentDataDir = (agentId: string): string =>
  path.join(resolveOpenHermitHome(), 'agents', agentId);

/**
 * Load environment variables from .env files.
 *
 * Priority (highest to lowest):
 *   1. Already-set process.env values (never overwritten)
 *   2. Project .env (cwd or explicit path)
 *   3. ~/.openhermit/.env
 *
 * Returns the number of new variables set.
 */
export const loadEnv = async (projectEnvPath?: string): Promise<number> => {
  const homeEnv = await tryLoadFile(path.join(resolveOpenHermitHome(), '.env'));
  const projectPath = projectEnvPath ?? path.resolve(process.cwd(), '.env');
  const projectEnv = await tryLoadFile(projectPath);

  // Merge: project overrides home
  const merged = new Map([...homeEnv, ...projectEnv]);

  let loaded = 0;
  for (const [key, value] of merged) {
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded += 1;
    }
  }

  return loaded;
};
