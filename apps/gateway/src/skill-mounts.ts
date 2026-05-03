/**
 * Sync platform/system skills into a workspace's `.openhermit/skills/system/` directory.
 * Each backend (host/docker/e2b) sees the workspace and the synced skills the same way.
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { DbSkillStore } from '@openhermit/store';

const SYSTEM_SKILLS_SUBPATH = ['.openhermit', 'skills', 'system'] as const;

/**
 * Sync the system skills directory inside the agent's workspace.
 * Copies enabled skill directories in, removes stale ones.
 */
export const syncSkillMounts = async (
  agentId: string,
  workspaceDir: string,
  skillStore: DbSkillStore,
): Promise<void> => {
  const systemSkillsDir = path.join(workspaceDir, ...SYSTEM_SKILLS_SUBPATH);
  await mkdir(systemSkillsDir, { recursive: true });

  const enabledSkills = await skillStore.listEnabled(agentId);
  const desired = new Map(enabledSkills.map((s) => [s.id, s.path]));

  let existing: string[];
  try {
    existing = await readdir(systemSkillsDir);
  } catch {
    existing = [];
  }

  for (const name of existing) {
    if (!desired.has(name)) {
      await rm(path.join(systemSkillsDir, name), { recursive: true, force: true });
    }
  }

  for (const [id, skillPath] of desired) {
    const destPath = path.join(systemSkillsDir, id);
    await rm(destPath, { recursive: true, force: true });
    await cp(skillPath, destPath, { recursive: true });
  }
};
