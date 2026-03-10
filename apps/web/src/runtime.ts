import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runtimeFiles } from '@openhermit/shared';

const readRuntimeValue = async (
  workspaceRoot: string,
  relativePath: string,
): Promise<string> => {
  const filePath = path.join(workspaceRoot, relativePath);
  return (await fs.readFile(filePath, 'utf8')).trim();
};

export interface AgentRuntimeConnection {
  baseUrl: string;
  token: string;
  port: string;
}

export const readAgentRuntimeConnection = async (
  workspaceRoot: string,
): Promise<AgentRuntimeConnection> => {
  const [port, token] = await Promise.all([
    readRuntimeValue(workspaceRoot, runtimeFiles.apiPort),
    readRuntimeValue(workspaceRoot, runtimeFiles.apiToken),
  ]);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    port,
  };
};
