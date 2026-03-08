import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { AgentSecurity, AgentWorkspace } from '../src/core/index.js';

export interface WorkspaceFixture {
  root: string;
  workspace: AgentWorkspace;
}

export interface SecurityFixture extends WorkspaceFixture {
  cloudMindHome: string;
  security: AgentSecurity;
}

export const createTempDir = async (
  t: TestContext,
  prefix: string,
): Promise<string> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
};

export const createWorkspaceFixture = async (
  t: TestContext,
): Promise<WorkspaceFixture> => {
  const root = await createTempDir(t, 'cloudmind-workspace-');
  const workspace = new AgentWorkspace(root);

  await workspace.init({
    agentId: 'agent-test',
    name: 'Test Agent',
    createdAt: '2026-03-08T00:00:00.000Z',
  });

  return {
    root,
    workspace,
  };
};

export const createSecurityFixture = async (
  t: TestContext,
): Promise<SecurityFixture> => {
  const workspaceFixture = await createWorkspaceFixture(t);
  const cloudMindHome = await createTempDir(t, 'cloudmind-home-');
  const security = new AgentSecurity({
    agentId: 'agent-test',
    workspace: workspaceFixture.workspace,
    cloudMindHome,
  });

  await security.init();

  return {
    ...workspaceFixture,
    cloudMindHome,
    security,
  };
};
