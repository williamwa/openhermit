/**
 * Maintain per-agent skill-mounts directories by copying skill contents.
 * The container mounts this single directory as /skills:ro.
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { DbSkillStore } from '@openhermit/store';

/**
 * Sync the skill-mounts directory for a given agent.
 * Copies enabled skill directories in, removes stale ones.
 */
export const syncSkillMounts = async (
  agentId: string,
  skillMountsDir: string,
  skillStore: DbSkillStore,
): Promise<void> => {
  await mkdir(skillMountsDir, { recursive: true });

  const enabledSkills = await skillStore.listEnabled(agentId);
  const desired = new Map(enabledSkills.map((s) => [s.id, s.path]));

  // Remove stale entries
  let existing: string[];
  try {
    existing = await readdir(skillMountsDir);
  } catch {
    existing = [];
  }

  for (const name of existing) {
    if (!desired.has(name)) {
      await rm(path.join(skillMountsDir, name), { recursive: true, force: true });
    }
  }

  // Copy skill directories
  for (const [id, skillPath] of desired) {
    const destPath = path.join(skillMountsDir, id);
    await rm(destPath, { recursive: true, force: true });
    await cp(skillPath, destPath, { recursive: true });
  }
};
