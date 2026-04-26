import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SecretStore } from '../interfaces.js';

/**
 * File-backed implementation of SecretStore. Each agent has a
 * `<configDir>/secrets.json` containing a flat string→string map.
 *
 * Lookups are by `agentId`; the file path is resolved through a
 * caller-supplied resolver so the gateway can pass in DbAgentStore's
 * record.configDir without this module taking a DB dependency.
 */
export type ConfigDirResolver = (agentId: string) => Promise<string>;

const readJsonSafe = async (filePath: string): Promise<Record<string, string>> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
};

const writeJsonAtomic = async (
  filePath: string,
  value: Record<string, string>,
): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const sorted: Record<string, string> = {};
  for (const k of Object.keys(value).sort()) sorted[k] = value[k]!;
  await fs.writeFile(filePath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
};

export class FileSecretStore implements SecretStore {
  constructor(private readonly resolveConfigDir: ConfigDirResolver) {}

  private async pathFor(agentId: string): Promise<string> {
    const dir = await this.resolveConfigDir(agentId);
    return path.join(dir, 'secrets.json');
  }

  async list(agentId: string): Promise<Record<string, string>> {
    return readJsonSafe(await this.pathFor(agentId));
  }

  async get(agentId: string, name: string): Promise<string | undefined> {
    const all = await this.list(agentId);
    return all[name];
  }

  async set(agentId: string, name: string, value: string): Promise<void> {
    const filePath = await this.pathFor(agentId);
    const all = await readJsonSafe(filePath);
    all[name] = value;
    await writeJsonAtomic(filePath, all);
  }

  async delete(agentId: string, name: string): Promise<void> {
    const filePath = await this.pathFor(agentId);
    const all = await readJsonSafe(filePath);
    if (!(name in all)) return;
    delete all[name];
    await writeJsonAtomic(filePath, all);
  }

  async setAll(agentId: string, secrets: Record<string, string>): Promise<void> {
    const filePath = await this.pathFor(agentId);
    await writeJsonAtomic(filePath, secrets);
  }
}
