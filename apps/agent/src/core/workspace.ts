import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';

import { NotFoundError, ValidationError } from '@cloudmind/shared';

import type { AgentConfig } from './types.js';

export interface WorkspaceInitOptions {
  agentId: string;
  name: string;
  createdAt?: string;
}

export interface ResolvePathOptions {
  mustExist?: boolean;
  kind?: 'file' | 'directory' | 'any';
}

export interface WorkspaceListEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
}

const DEFAULT_MODEL = {
  provider: 'anthropic',
  model: 'claude-opus-4-5',
  max_tokens: 8192,
} as const;

const DEFAULT_HOOKS = {
  beforeToolCall: ['log'],
  afterToolCall: ['log'],
  onSessionStart: ['log'],
  onSessionEnd: ['log'],
  onScheduleTrigger: ['log'],
};

const IDENTITY_FILES = {
  'identity/IDENTITY.md': `# IDENTITY

Name: {name}
Role: A pragmatic autonomous coding agent.
`,
  'identity/SOUL.md': `# SOUL

Values:
- clarity
- rigor
- pragmatic execution
`,
  'identity/USER.md': `# USER

Describe the human this agent is helping.
`,
  'identity/AGENTS.md': `# AGENTS

Use this file for workspace-specific instructions, preferences, and collaboration rules.
`,
} as const;

const OTHER_SCAFFOLD_FILES = {
  'memory/working.md': '# Working Memory\n',
  'memory/long-term.md': '# Long-Term Memory\n\n## Index\n',
  'memory/heartbeat.md': '# Heartbeat Checklist\n',
  'hooks/hooks.json': '{}\n',
  'containers/registry.jsonl': '',
} as const;

const SCAFFOLD_DIRECTORIES = [
  'identity',
  'memory',
  'memory/episodic',
  'memory/notes',
  'sessions',
  'containers',
  'files',
  'hooks',
  'runtime',
  'logs',
] as const;

const isPathOutsideRoot = (relativePath: string): boolean =>
  relativePath === '..' ||
  relativePath.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relativePath);

const replaceTemplateTokens = (
  template: string,
  values: Record<string, string>,
): string =>
  Object.entries(values).reduce(
    (content, [key, value]) => content.replaceAll(`{${key}}`, value),
    template,
  );

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

const fileTypeFromDirent = (entry: Dirent): WorkspaceListEntry['type'] => {
  if (entry.isFile()) {
    return 'file';
  }

  if (entry.isDirectory()) {
    return 'directory';
  }

  if (entry.isSymbolicLink()) {
    return 'symlink';
  }

  return 'other';
};

export const createDefaultAgentConfig = ({
  agentId,
  name,
  createdAt = new Date().toISOString(),
}: WorkspaceInitOptions): AgentConfig => ({
  agent_id: agentId,
  name,
  created: createdAt,
  model: { ...DEFAULT_MODEL },
  identity: {
    files: [
      'identity/IDENTITY.md',
      'identity/SOUL.md',
      'identity/USER.md',
      'identity/AGENTS.md',
    ],
  },
  container_defaults: {
    memory_limit: '512m',
    cpu_shares: 512,
    network: 'bridge',
  },
  hooks: {
    beforeToolCall: [...DEFAULT_HOOKS.beforeToolCall],
    afterToolCall: [...DEFAULT_HOOKS.afterToolCall],
    onSessionStart: [...DEFAULT_HOOKS.onSessionStart],
    onSessionEnd: [...DEFAULT_HOOKS.onSessionEnd],
    onScheduleTrigger: [...DEFAULT_HOOKS.onScheduleTrigger],
  },
  heartbeat: {
    enabled: true,
    interval_minutes: 60,
    max_iterations: 10,
    tools_allowed: [
      'read_file',
      'write_file',
      'list_files',
      'container_status',
    ],
  },
  schedules: {
    jobs: [],
  },
  http_api: {
    preferred_port: 3000,
  },
  channels: {
    telegram_bridge: {
      enabled: false,
      allowed_chat_ids: [],
    },
  },
});

export class AgentWorkspace {
  constructor(public readonly root: string) {}

  async init(options: WorkspaceInitOptions): Promise<AgentConfig> {
    await fs.mkdir(this.root, { recursive: true });

    for (const relativeDir of SCAFFOLD_DIRECTORIES) {
      await fs.mkdir(path.join(this.root, relativeDir), { recursive: true });
    }

    const config = createDefaultAgentConfig(options);
    const configPath = path.join(this.root, 'config.json');

    try {
      await fs.access(configPath);
    } catch {
      await this.writeConfig(config);
    }

    for (const [relativePath, template] of Object.entries(IDENTITY_FILES)) {
      await this.ensureFile(
        relativePath,
        replaceTemplateTokens(template, { name: options.name }),
      );
    }

    for (const [relativePath, content] of Object.entries(OTHER_SCAFFOLD_FILES)) {
      await this.ensureFile(relativePath, content);
    }

    return this.readConfig();
  }

  async readConfig(): Promise<AgentConfig> {
    const configPath = await this.resolve('config.json', {
      mustExist: true,
      kind: 'file',
    });
    const content = await fs.readFile(configPath, 'utf8');

    return JSON.parse(content) as AgentConfig;
  }

  async writeConfig(config: AgentConfig): Promise<void> {
    await this.writeFile('config.json', `${JSON.stringify(config, null, 2)}\n`);
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

  async ensureDir(relativePath: string): Promise<string> {
    const target = await this.resolve(relativePath);
    await fs.mkdir(target, { recursive: true });
    return target;
  }

  async ensureFile(relativePath: string, content: string): Promise<string> {
    const target = await this.resolve(relativePath);

    try {
      await fs.access(target);
      return target;
    } catch {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      return target;
    }
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

  async deleteFile(relativePath: string): Promise<void> {
    const target = await this.resolve(relativePath, {
      mustExist: true,
      kind: 'file',
    });
    await fs.unlink(target);
  }

  async listFiles(relativePath = '.'): Promise<WorkspaceListEntry[]> {
    const target = await this.resolve(relativePath, {
      mustExist: true,
      kind: 'directory',
    });
    const entries = await fs.readdir(target, { withFileTypes: true });

    return entries.map((entry) => ({
      name: entry.name,
      path: path.posix.join(relativePath === '.' ? '' : relativePath, entry.name),
      type: fileTypeFromDirent(entry),
    }));
  }

  toRelativePath(targetPath: string): string {
    const relativePath = path.relative(this.root, targetPath);

    if (isPathOutsideRoot(relativePath)) {
      throw new ValidationError(`Path is outside workspace: ${targetPath}`);
    }

    return relativePath === '' ? '.' : relativePath.split(path.sep).join(path.posix.sep);
  }
}
