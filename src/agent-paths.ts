import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AgentPathOptions } from './types.ts';

const DEFAULT_AGENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertValidAgentId(agentId: string): void {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('agentId must be a non-empty string');
  }

  if (!DEFAULT_AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid agentId "${agentId}"`);
  }
}

export function resolveCloudMindHome(cloudmindHome?: string): string {
  return resolve(cloudmindHome ?? join(homedir(), '.cloudmind'));
}

export function getAgentDirectory(agentId: string, options: AgentPathOptions = {}): string {
  assertValidAgentId(agentId);
  return join(resolveCloudMindHome(options.cloudmindHome), agentId);
}

export function getSecurityFilePath(agentId: string, options: AgentPathOptions = {}): string {
  return join(getAgentDirectory(agentId, options), 'security.json');
}

export function getSecretsFilePath(agentId: string, options: AgentPathOptions = {}): string {
  return join(getAgentDirectory(agentId, options), 'secrets.json');
}
