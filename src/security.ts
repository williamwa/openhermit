import { access, mkdir } from 'node:fs/promises';

import { getAgentDirectory, getSecurityFilePath } from './agent-paths.ts';
import { writeJsonAtomic } from './io.ts';
import { readJsonFile } from './json.ts';

import type { AgentPathOptions, AutonomyLevel, SecurityConfig } from './types.ts';

export const DEFAULT_SECURITY: SecurityConfig = {
  autonomy_level: 'supervised',
  require_approval_for: ['container_run'],
};

const VALID_AUTONOMY_LEVELS = new Set<AutonomyLevel>(['readonly', 'supervised', 'full']);

function validateSecurity(value: unknown): SecurityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Security config must be an object');
  }

  const candidate = value as Partial<SecurityConfig>;

  if (!VALID_AUTONOMY_LEVELS.has(candidate.autonomy_level as AutonomyLevel)) {
    throw new Error(`Invalid autonomy level "${String(candidate.autonomy_level)}"`);
  }

  if (!Array.isArray(candidate.require_approval_for)) {
    throw new Error('require_approval_for must be an array');
  }

  for (const toolName of candidate.require_approval_for) {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new Error('require_approval_for entries must be non-empty strings');
    }
  }

  return {
    autonomy_level: candidate.autonomy_level as AutonomyLevel,
    require_approval_for: [...candidate.require_approval_for],
  };
}

export async function initSecurity(agentId: string, options: AgentPathOptions = {}): Promise<string> {
  const agentDirectory = getAgentDirectory(agentId, options);
  const securityPath = getSecurityFilePath(agentId, options);

  await mkdir(agentDirectory, { recursive: true });
  try {
    await access(securityPath);
  } catch {
    await writeJsonAtomic(securityPath, DEFAULT_SECURITY);
  }

  return securityPath;
}

export async function loadSecurity(
  agentId: string,
  options: AgentPathOptions = {},
): Promise<SecurityConfig> {
  return validateSecurity(await readJsonFile<unknown>(getSecurityFilePath(agentId, options)));
}

export function getAutonomyLevel(security: unknown): AutonomyLevel {
  return validateSecurity(security).autonomy_level;
}

export function requiresApproval(security: unknown, toolName: string): boolean {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new Error('toolName must be a non-empty string');
  }

  return validateSecurity(security).require_approval_for.includes(toolName);
}
