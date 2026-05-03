/**
 * Host exec backend allows the agent to run commands directly on the gateway
 * machine — there's no per-agent sandbox. Two host-backend agents would share
 * `$HOME`, `$HOME/.openhermit/skills/`, and `$HOME/.openhermit/tool_results/`,
 * so we enforce at most one per gateway.
 */

import { ValidationError } from '@openhermit/shared';
import type { AgentConfigStore, DbAgentStore } from '@openhermit/store';

const configHasHostBackend = (config: Record<string, unknown> | null | undefined): boolean => {
  if (!config) return false;
  const exec = config['exec'] as { backends?: Array<{ type?: string }> } | undefined;
  return (exec?.backends ?? []).some((b) => b?.type === 'host');
};

/**
 * Throws if applying `proposedConfig` to `targetAgentId` would result in two
 * agents using the host backend. Pass when no other agent uses host, or when
 * the proposed config doesn't enable host.
 */
export const assertHostBackendIsUnique = async (
  targetAgentId: string,
  proposedConfig: Record<string, unknown>,
  agentStore: DbAgentStore,
  configStore: AgentConfigStore,
): Promise<void> => {
  if (!configHasHostBackend(proposedConfig)) return;

  const allAgents = await agentStore.list();
  for (const agent of allAgents) {
    if (agent.agentId === targetAgentId) continue;
    const otherConfig = await configStore.getConfig(agent.agentId);
    if (configHasHostBackend(otherConfig)) {
      throw new ValidationError(
        `Cannot enable host exec backend on "${targetAgentId}": ` +
          `agent "${agent.agentId}" already uses it. Only one host-backend agent is allowed per gateway.`,
      );
    }
  }
};

/** Same as `assertHostBackendIsUnique` but returns the conflicting id instead of throwing. */
export const findConflictingHostAgent = async (
  targetAgentId: string,
  proposedConfig: Record<string, unknown>,
  agentStore: DbAgentStore,
  configStore: AgentConfigStore,
): Promise<string | null> => {
  if (!configHasHostBackend(proposedConfig)) return null;

  const allAgents = await agentStore.list();
  for (const agent of allAgents) {
    if (agent.agentId === targetAgentId) continue;
    const otherConfig = await configStore.getConfig(agent.agentId);
    if (configHasHostBackend(otherConfig)) return agent.agentId;
  }
  return null;
};
