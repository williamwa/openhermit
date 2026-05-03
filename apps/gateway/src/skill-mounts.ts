/**
 * Sync platform/system skills into a running agent's exec backends.
 *
 * Each backend (host/docker/e2b) decides where to write:
 *   - docker → bind-mount source dir (workspace's `.openhermit/skills/system/`)
 *   - host   → `$HOME/.openhermit/skills/system/`
 *   - e2b    → uploaded via SDK to `<agentHome>/.openhermit/skills/system/`
 */

import type { AgentRunner } from '@openhermit/agent/agent-runner';
import type { DbSkillStore } from '@openhermit/store';

export const syncSkillMounts = async (
  agentId: string,
  runner: AgentRunner,
  skillStore: DbSkillStore,
): Promise<void> => {
  const enabled = await skillStore.listEnabled(agentId);
  await runner.syncSkills(enabled.map((s) => ({ id: s.id, sourcePath: s.path })));
};
