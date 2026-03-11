import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AgentWorkspace } from '../core/index.js';
import type {
  EpisodicLogEntry,
  SessionLogEntry,
} from './types.js';
import { createSessionStartedEntries, type SessionLogPaths } from './types.js';
import type { SessionSpec } from '@openhermit/protocol';

const ensureJsonlFile = async (
  workspace: AgentWorkspace,
  relativePath: string,
): Promise<string> => {
  const target = await workspace.resolve(relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
};

const appendJsonl = async (
  workspace: AgentWorkspace,
  relativePath: string,
  value: unknown,
): Promise<void> => {
  const target = await ensureJsonlFile(workspace, relativePath);
  await fs.appendFile(target, `${JSON.stringify(value)}\n`, 'utf8');
};

export class SessionLogWriter {
  constructor(private readonly workspace: AgentWorkspace) {}

  async appendSession(relativePath: string, entry: SessionLogEntry): Promise<void> {
    await appendJsonl(this.workspace, relativePath, entry);
  }

  async appendEpisodic(relativePath: string, entry: EpisodicLogEntry): Promise<void> {
    await appendJsonl(this.workspace, relativePath, entry);
  }

  async writeSessionStarted(
    paths: SessionLogPaths,
    spec: SessionSpec,
    model: { provider: string; model: string },
  ): Promise<void> {
    const entries = createSessionStartedEntries(paths, spec, model);

    await this.appendSession(entries.paths.sessionLogRelativePath, entries.session);
  }
}
