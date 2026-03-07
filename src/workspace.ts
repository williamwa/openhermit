import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { writeJsonAtomic, writeTextAtomic } from './io.ts';
import { readJsonFile } from './json.ts';

import type { WorkspaceConfig } from './types.ts';

const DEFAULT_IDENTITY_FILES: Record<string, string> = {
  'IDENTITY.md': '# Identity\n\nName: CloudMind Agent\n',
  'SOUL.md': '# Soul\n\n- Be precise.\n- Be pragmatic.\n- Be safe.\n',
  'USER.md': '# User\n\nUnknown.\n',
  'AGENTS.md': '# Agent Rules\n\n- Stay inside the workspace.\n- Use tools instead of host shell.\n',
};

const WRITABLE_PREFIXES = ['files/', 'memory/notes/'];
const WRITABLE_EXACT_PATHS = new Set<string>(['files', 'memory/working.md', 'memory/notes']);

function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

function isWithinPath(rootPath: string, candidatePath: string): boolean {
  if (candidatePath === rootPath) {
    return true;
  }

  const normalizedRoot = rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`;
  return candidatePath.startsWith(normalizedRoot);
}

function assertSafeRelativePath(relativePath: string): void {
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

function assertWritableRelativePath(relativePath: string): void {
  if (WRITABLE_EXACT_PATHS.has(relativePath)) {
    return;
  }

  if (WRITABLE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return;
  }

  throw new Error(`Writes are not allowed for "${relativePath}"`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkspaceRoot(workspaceRoot: string): Promise<string> {
  return realpath(resolve(workspaceRoot));
}

async function findNearestExistingParent(candidatePath: string, rootPath: string): Promise<string> {
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

function createDefaultConfig(agentId: string): WorkspaceConfig {
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

function validateConfig(config: unknown): WorkspaceConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Workspace config must be an object');
  }

  const candidate = config as Partial<WorkspaceConfig>;

  if (typeof candidate.agent_id !== 'string' || candidate.agent_id.length === 0) {
    throw new Error('config.agent_id must be a non-empty string');
  }

  if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
    throw new Error('config.name must be a non-empty string');
  }

  return config as WorkspaceConfig;
}

export async function initWorkspace(agentId: string, workspaceRoot: string): Promise<string> {
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

export async function readConfig(workspaceRoot: string): Promise<WorkspaceConfig> {
  return validateConfig(
    await readJsonFile<unknown>(join(resolve(workspaceRoot), 'config.json')),
  );
}

export async function resolveReadPath(workspaceRoot: string, relativePath: string): Promise<string> {
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

export async function resolveWritePath(workspaceRoot: string, relativePath: string): Promise<string> {
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
