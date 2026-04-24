import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  internalStateFiles,
  type RuntimeStateFile,
} from '@openhermit/shared';

export interface SlackAdapterConfig {
  botToken: string;
  appToken: string;
  agentBaseUrl: string;
  agentToken: string;
}

const resolveOpenHermitHome = (): string =>
  process.env.OPENHERMIT_HOME ?? path.join(os.homedir(), '.openhermit');

const readRuntimeState = async (agentId: string): Promise<RuntimeStateFile> => {
  const runtimePath = path.join(
    resolveOpenHermitHome(),
    agentId,
    internalStateFiles.runtime,
  );
  const content = await fs.readFile(runtimePath, 'utf8');
  const parsed = JSON.parse(content) as Partial<RuntimeStateFile>;
  const port = parsed.http_api?.port;
  const token = parsed.http_api?.token;

  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port <= 0 ||
    typeof token !== 'string' ||
    token.length === 0
  ) {
    throw new Error(`Invalid runtime.json for agent: ${agentId}`);
  }

  return {
    http_api: { port, token },
    updated_at:
      typeof parsed.updated_at === 'string'
        ? parsed.updated_at
        : new Date(0).toISOString(),
  };
};

export const loadConfig = async (): Promise<SlackAdapterConfig> => {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken) throw new Error('SLACK_BOT_TOKEN environment variable is required.');
  if (!appToken) throw new Error('SLACK_APP_TOKEN environment variable is required (xapp-...).');

  let agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  let agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  if (!agentBaseUrl && process.env.OPENHERMIT_AGENT_ID) {
    const runtime = await readRuntimeState(process.env.OPENHERMIT_AGENT_ID);
    agentBaseUrl = `http://localhost:${runtime.http_api.port}`;
    agentToken = runtime.http_api.token;
  }

  if (!agentBaseUrl || !agentToken) {
    throw new Error(
      'Agent connection required. Set OPENHERMIT_AGENT_URL + OPENHERMIT_AGENT_TOKEN, or OPENHERMIT_AGENT_ID for auto-discovery.',
    );
  }

  return { botToken, appToken, agentBaseUrl, agentToken };
};
