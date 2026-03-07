import { access, mkdir } from 'node:fs/promises';

import { getAgentDirectory, getSecretsFilePath } from './agent-paths.js';
import { writeJsonAtomic } from './io.js';
import { readJsonFile } from './json.js';

function validateSecrets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Secrets config must be an object');
  }

  const result = {};

  for (const [name, secretValue] of Object.entries(value)) {
    if (typeof secretValue !== 'string') {
      throw new Error(`Secret "${name}" must be a string`);
    }

    result[name] = secretValue;
  }

  return result;
}

export async function initSecrets(agentId, options = {}) {
  const agentDirectory = getAgentDirectory(agentId, options);
  const secretsPath = getSecretsFilePath(agentId, options);

  await mkdir(agentDirectory, { recursive: true });
  try {
    await access(secretsPath);
  } catch {
    await writeJsonAtomic(secretsPath, {});
  }

  return secretsPath;
}

export async function loadSecrets(agentId, options = {}) {
  return validateSecrets(await readJsonFile(getSecretsFilePath(agentId, options)));
}

export function listSecretNames(secrets) {
  return Object.keys(validateSecrets(secrets)).sort();
}

export function resolveSecrets(secrets, names) {
  if (!Array.isArray(names)) {
    throw new Error('names must be an array');
  }

  const validatedSecrets = validateSecrets(secrets);
  const resolved = {};

  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('Secret names must be non-empty strings');
    }

    if (!(name in validatedSecrets)) {
      throw new Error(`Unknown secret "${name}"`);
    }

    resolved[name] = validatedSecrets[name];
  }

  return resolved;
}

export function describeResolvedSecrets(names) {
  if (!Array.isArray(names) || names.length === 0) {
    return 'env vars set: none';
  }

  return `env vars set: ${names.join(', ')}`;
}
