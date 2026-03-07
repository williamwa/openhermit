import { access, mkdir } from 'node:fs/promises';

import { getAgentDirectory, getSecurityFilePath } from './agent-paths.js';
import { writeJsonAtomic } from './io.js';
import { readJsonFile } from './json.js';

export const DEFAULT_SECURITY = {
  autonomy_level: 'supervised',
  require_approval_for: ['container_run'],
};

const VALID_AUTONOMY_LEVELS = new Set(['readonly', 'supervised', 'full']);

function validateSecurity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Security config must be an object');
  }

  if (!VALID_AUTONOMY_LEVELS.has(value.autonomy_level)) {
    throw new Error(`Invalid autonomy level "${value.autonomy_level}"`);
  }

  if (!Array.isArray(value.require_approval_for)) {
    throw new Error('require_approval_for must be an array');
  }

  for (const toolName of value.require_approval_for) {
    if (typeof toolName !== 'string' || toolName.length === 0) {
      throw new Error('require_approval_for entries must be non-empty strings');
    }
  }

  return {
    autonomy_level: value.autonomy_level,
    require_approval_for: [...value.require_approval_for],
  };
}

export async function initSecurity(agentId, options = {}) {
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

export async function loadSecurity(agentId, options = {}) {
  return validateSecurity(await readJsonFile(getSecurityFilePath(agentId, options)));
}

export function getAutonomyLevel(security) {
  return validateSecurity(security).autonomy_level;
}

export function requiresApproval(security, toolName) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    throw new Error('toolName must be a non-empty string');
  }

  return validateSecurity(security).require_approval_for.includes(toolName);
}
