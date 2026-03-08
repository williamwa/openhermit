import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SessionSpec } from '@cloudmind/protocol';

import { AgentWorkspace } from './core/index.js';

export interface SessionLogEntry {
  ts: string;
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error';
  type?: string;
  [key: string]: unknown;
}

export interface EpisodicLogEntry {
  ts: string;
  session: string;
  type: string;
  data: Record<string, unknown>;
}

export interface SessionLogPaths {
  sessionLogRelativePath: string;
  episodicRelativePath: string;
}

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

const sanitizeSessionId = (sessionId: string): string =>
  sessionId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'session';

export const createSessionLogPaths = (
  sessionId: string,
  createdAt: string,
): SessionLogPaths => ({
  sessionLogRelativePath: `sessions/${createdAt.slice(0, 10)}-${sanitizeSessionId(sessionId)}.jsonl`,
  episodicRelativePath: `memory/episodic/${createdAt.slice(0, 7)}.jsonl`,
});

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
    const ts = new Date().toISOString();

    await Promise.all([
      this.appendSession(paths.sessionLogRelativePath, {
        ts,
        role: 'system',
        type: 'session_started',
        sessionId: spec.sessionId,
        source: spec.source,
        ...(spec.metadata ? { metadata: spec.metadata } : {}),
        model,
      }),
      this.appendEpisodic(paths.episodicRelativePath, {
        ts,
        session: spec.sessionId,
        type: 'session_started',
        data: {
          source: spec.source,
          ...(spec.metadata ? { metadata: spec.metadata } : {}),
          model,
        },
      }),
    ]);
  }
}
