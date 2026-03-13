import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  internalStateFiles,
  type RuntimeStateFile,
  ValidationError,
} from '@openhermit/shared';

const resolveOpenHermitHome = (env: NodeJS.ProcessEnv): string =>
  env.OPENHERMIT_HOME ?? path.join(os.homedir(), '.openhermit');

const resolveRuntimeFilePath = (
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  path.join(resolveOpenHermitHome(env), agentId, internalStateFiles.runtime);

export interface AgentRuntimeConnection {
  baseUrl: string;
  token: string;
  port: string;
}

export const readAgentRuntimeConnection = async (
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentRuntimeConnection> => {
  const content = await fs.readFile(resolveRuntimeFilePath(agentId, env), 'utf8');
  const parsed = JSON.parse(content) as Partial<RuntimeStateFile>;
  const port = parsed.http_api?.port;
  const token = parsed.http_api?.token;

  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || typeof token !== 'string' || token.length === 0) {
    throw new ValidationError(`Invalid runtime metadata for agent: ${agentId}`);
  }

  const validatedPort = port as number;

  return {
    baseUrl: `http://127.0.0.1:${validatedPort}`,
    token,
    port: String(validatedPort),
  };
};
