import { promises as fs } from 'node:fs';
import path from 'node:path';

import { NotFoundError, ValidationError } from '@openhermit/shared';

import type { WorkspaceConfig } from './types.js';

export interface WorkspaceInitOptions {
  agentId: string;
  createdAt?: string;
}

export interface ResolvePathOptions {
  mustExist?: boolean;
  kind?: 'file' | 'directory' | 'any';
}

const SCAFFOLD_DIRECTORIES = [
  '.openhermit',
  'containers',
] as const;

const isPathOutsideRoot = (relativePath: string): boolean =>
  relativePath === '..' ||
  relativePath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativePath);

const ensureWithinRoot = (root: string, candidate: string): void => {
  const relativePath = path.relative(root, candidate);

  if (isPathOutsideRoot(relativePath)) {
    throw new ValidationError(`Path escapes workspace root: ${candidate}`);
  }
};

const findNearestExistingAncestor = async (
  candidate: string,
  root: string,
): Promise<string> => {
  let current = path.dirname(candidate);

  while (true) {
    try {
      await fs.access(current);
      return current;
    } catch (error) {
      if (current === root || current === path.dirname(current)) {
        return root;
      }

      current = path.dirname(current);
    }
  }
};

const parseJsonFile = <T>(content: string, filePath: string): T => {
  try {
    return JSON.parse(content) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ValidationError(
      `Invalid JSON in ${filePath}: ${message}`,
    );
  }
};

export const createDefaultWorkspaceConfig = (): WorkspaceConfig => ({
  channels: {
    telegram_bridge: {
      enabled: false,
      allowed_chat_ids: [],
    },
  },
});

export class AgentWorkspace {
  constructor(public readonly root: string) {}

  async init(options: WorkspaceInitOptions): Promise<WorkspaceConfig> {
    await fs.mkdir(this.root, { recursive: true });

    for (const relativeDir of SCAFFOLD_DIRECTORIES) {
      await fs.mkdir(path.join(this.root, relativeDir), { recursive: true });
    }

    const config = createDefaultWorkspaceConfig();
    const configPath = path.join(this.root, '.openhermit', 'config.json');

    try {
      await fs.access(configPath);
    } catch {
      await this.writeConfig(config);
    }

    return this.readConfig();
  }

  async readConfig(): Promise<WorkspaceConfig> {
    const configPath = await this.resolve('.openhermit/config.json', {
      mustExist: true,
      kind: 'file',
    });
    const content = await fs.readFile(configPath, 'utf8');

    return parseJsonFile<WorkspaceConfig>(content, configPath);
  }

  async writeConfig(config: WorkspaceConfig): Promise<void> {
    await this.writeFile('.openhermit/config.json', `${JSON.stringify(config, null, 2)}\n`);
  }

  async resolve(
    relativePath: string,
    options: ResolvePathOptions = {},
  ): Promise<string> {
    if (relativePath.includes('\0')) {
      throw new ValidationError('Path may not contain a null byte.');
    }

    await fs.mkdir(this.root, { recursive: true });

    const canonicalRoot = await fs.realpath(this.root);
    const resolvedPath = path.resolve(this.root, relativePath);
    const lexicalRelative = path.relative(this.root, resolvedPath);

    if (isPathOutsideRoot(lexicalRelative)) {
      throw new ValidationError(`Path escapes workspace root: ${relativePath}`);
    }

    const mustExist = options.mustExist ?? false;

    if (mustExist) {
      try {
        const canonicalTarget = await fs.realpath(resolvedPath);
        ensureWithinRoot(canonicalRoot, canonicalTarget);
      } catch (error) {
        throw new NotFoundError(`Workspace path not found: ${relativePath}`);
      }
    } else {
      try {
        const canonicalTarget = await fs.realpath(resolvedPath);
        ensureWithinRoot(canonicalRoot, canonicalTarget);
      } catch {
        const ancestor = await findNearestExistingAncestor(resolvedPath, this.root);
        const canonicalAncestor = await fs.realpath(ancestor);
        ensureWithinRoot(canonicalRoot, canonicalAncestor);
      }
    }

    if (options.kind && options.kind !== 'any') {
      try {
        const stats = await fs.stat(resolvedPath);

        if (options.kind === 'file' && !stats.isFile()) {
          throw new ValidationError(`Expected file path: ${relativePath}`);
        }

        if (options.kind === 'directory' && !stats.isDirectory()) {
          throw new ValidationError(`Expected directory path: ${relativePath}`);
        }
      } catch (error) {
        if (error instanceof ValidationError) {
          throw error;
        }

        throw new NotFoundError(`Workspace path not found: ${relativePath}`);
      }
    }

    return resolvedPath;
  }

  async readFile(relativePath: string): Promise<string> {
    const target = await this.resolve(relativePath, {
      mustExist: true,
      kind: 'file',
    });
    return fs.readFile(target, 'utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const target = await this.resolve(relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }


  toRelativePath(targetPath: string): string {
    const relativePath = path.relative(this.root, targetPath);

    if (isPathOutsideRoot(relativePath)) {
      throw new ValidationError(`Path is outside workspace: ${targetPath}`);
    }

    return relativePath === '' ? '.' : relativePath.split(path.sep).join(path.posix.sep);
  }
}
