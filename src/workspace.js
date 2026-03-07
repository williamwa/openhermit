import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from './io.js';
import { readJsonFile } from './json.js';

const DEFAULT_IDENTITY_FILES = {
  'IDENTITY.md': '# Identity\n\nName: CloudMind Agent\n',
  'SOUL.md': '# Soul\n\n- Be precise.\n- Be pragmatic.\n- Be safe.\n',
  'USER.md': '# User\n\nUnknown.\n',
  'AGENTS.md': '# Agent Rules\n\n- Stay inside the workspace.\n- Use tools instead of host shell.\n',
};

const WRITABLE_PREFIXES = ['files/', 'memory/notes/'];
const WRITABLE_EXACT_PATHS = new Set(['files', 'memory/working.md', 'memory/notes']);

function toPosixPath(value) {
  return value.split(sep).join('/');
}

function isWithinPath(rootPath, candidatePath) {
  if (candidatePath === rootPath) {
    return true;
  }

  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath.startsWith(normalizedRoot);
}

function assertSafeRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('Path must be a non-empty string');
  }

  if (relativePath.includes('\0')) {
    throw new Error('Null bytes are not allowed in paths');
  }

  if (isAbsolute(relativePath)) {
    throw new Error('Absolute paths are not allowed');
  }
}

function assertWritableRelativePath(relativePath) {
  if (WRITABLE_EXACT_PATHS.has(relativePath)) {
    return;
  }

  if (WRITABLE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return;
  }

  throw new Error(`Writes are not allowed for "${relativePath}"`);
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceRoot(workspaceRoot) {
  return realpath(resolve(workspaceRoot));
}

async function findNearestExistingParent(candidatePath, rootPath) {
  let currentPath = candidatePath;

  while (true) {
    if (await pathExists(currentPath)) {
      return currentPath;
    }

    if (currentPath === rootPath) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) {
      throw new Error(`Could not find an existing parent for "${candidatePath}"`);
    }

    currentPath = parentPath;
  }
}

function createDefaultConfig(agentId) {
  return {
    agent_id: agentId,
    name: 'My Agent',
    created: new Date().toISOString(),
    model: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
    },
    identity: {
      files: [
        'identity/IDENTITY.md',
        'identity/SOUL.md',
        'identity/USER.md',
        'identity/AGENTS.md',
      ],
    },
    container_defaults: {
      image_allowlist: ['python:3.12-slim', 'node:22-slim'],
      memory_limit: '512m',
      cpu_shares: 512,
      timeout_seconds: 120,
      network: 'disabled',
    },
  };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Workspace config must be an object');
  }

  if (typeof config.agent_id !== 'string' || config.agent_id.length === 0) {
    throw new Error('config.agent_id must be a non-empty string');
  }

  if (typeof config.name !== 'string' || config.name.length === 0) {
    throw new Error('config.name must be a non-empty string');
  }

  return config;
}

export async function initWorkspace(agentId, workspaceRoot) {
  const resolvedWorkspaceRoot = resolve(workspaceRoot);

  await mkdir(resolvedWorkspaceRoot, { recursive: true });

  const directories = [
    'identity',
    'memory/episodic',
    'memory/notes',
    'sessions',
    'files',
    'logs',
  ];

  await Promise.all(
    directories.map((directory) =>
      mkdir(join(resolvedWorkspaceRoot, directory), { recursive: true }),
    ),
  );

  const configPath = join(resolvedWorkspaceRoot, 'config.json');
  if (!(await pathExists(configPath))) {
    await writeJsonAtomic(configPath, createDefaultConfig(agentId));
  }

  await Promise.all(
    Object.entries(DEFAULT_IDENTITY_FILES).map(async ([fileName, contents]) => {
      const identityPath = join(resolvedWorkspaceRoot, 'identity', fileName);
      if (!(await pathExists(identityPath))) {
        await writeTextAtomic(identityPath, contents);
      }
    }),
  );

  const workingMemoryPath = join(resolvedWorkspaceRoot, 'memory', 'working.md');
  if (!(await pathExists(workingMemoryPath))) {
    await writeTextAtomic(workingMemoryPath, '# Working Memory\n\n');
  }

  return resolvedWorkspaceRoot;
}

export async function readConfig(workspaceRoot) {
  return validateConfig(await readJsonFile(join(resolve(workspaceRoot), 'config.json')));
}

export async function resolveReadPath(workspaceRoot, relativePath) {
  assertSafeRelativePath(relativePath);

  const rootPath = await resolveWorkspaceRoot(workspaceRoot);
  const candidatePath = resolve(rootPath, relativePath);

  if (!isWithinPath(rootPath, candidatePath)) {
    throw new Error(`Read path escapes the workspace: "${relativePath}"`);
  }

  const realTargetPath = await realpath(candidatePath);
  if (!isWithinPath(rootPath, realTargetPath)) {
    throw new Error(`Read path escapes the workspace after symlink resolution: "${relativePath}"`);
  }

  return realTargetPath;
}

export async function resolveWritePath(workspaceRoot, relativePath) {
  assertSafeRelativePath(relativePath);

  const rootPath = await resolveWorkspaceRoot(workspaceRoot);
  const candidatePath = resolve(rootPath, relativePath);

  if (!isWithinPath(rootPath, candidatePath)) {
    throw new Error(`Write path escapes the workspace: "${relativePath}"`);
  }

  const normalizedRelativePath = toPosixPath(relative(rootPath, candidatePath));
  assertWritableRelativePath(normalizedRelativePath);

  const nearestExistingParent = await findNearestExistingParent(dirname(candidatePath), rootPath);
  const realParentPath = await realpath(nearestExistingParent);

  if (!isWithinPath(rootPath, realParentPath)) {
    throw new Error(
      `Write path escapes the workspace after symlink resolution: "${relativePath}"`,
    );
  }

  const parentStats = await lstat(realParentPath);
  if (!parentStats.isDirectory()) {
    throw new Error(`Write parent is not a directory: "${realParentPath}"`);
  }

  return candidatePath;
}
