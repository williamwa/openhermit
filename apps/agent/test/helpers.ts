import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { AgentSecurity, AgentWorkspace } from '../src/core/index.js';
import type { SecretsMap, SecurityPolicy } from '../src/core/types.js';

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
  options?: {
    secrets?: SecretsMap;
    security?: Partial<SecurityPolicy>;
  },
): Promise<SecurityFixture> => {
  const workspaceFixture = await createWorkspaceFixture(t);
  const cloudMindHome = await createTempDir(t, 'cloudmind-home-');
  const security = new AgentSecurity({
    agentId: 'agent-test',
    workspace: workspaceFixture.workspace,
    cloudMindHome,
  });

  await security.init();

  if (options?.secrets) {
    await fs.writeFile(
      security.secretsFilePath,
      `${JSON.stringify(options.secrets, null, 2)}\n`,
      'utf8',
    );
  }

  if (options?.security) {
    const existing = JSON.parse(
      await fs.readFile(security.securityFilePath, 'utf8'),
    ) as SecurityPolicy;
    const merged: SecurityPolicy = { ...existing, ...options.security };
    await fs.writeFile(
      security.securityFilePath,
      `${JSON.stringify(merged, null, 2)}\n`,
      'utf8',
    );
  }

  return {
    ...workspaceFixture,
    cloudMindHome,
    security,
  };
};
