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

export const resolveRuntimeFilePath = (
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string =>
  path.join(resolveOpenHermitHome(env), agentId, internalStateFiles.runtime);

export const readRuntimeState = async (
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeStateFile> => {
  const content = await fs.readFile(resolveRuntimeFilePath(agentId, env), 'utf8');
  const parsed = JSON.parse(content) as Partial<RuntimeStateFile>;
  const port = parsed.http_api?.port;
  const token = parsed.http_api?.token;

  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || typeof token !== 'string' || token.length === 0) {
    throw new ValidationError(`Invalid runtime metadata for agent: ${agentId}`);
  }

  const validatedPort = port as number;

  return {
    http_api: {
      port: validatedPort,
      token,
    },
    updated_at:
      typeof parsed.updated_at === 'string'
        ? parsed.updated_at
        : new Date(0).toISOString(),
  };
};
