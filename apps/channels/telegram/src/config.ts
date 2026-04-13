import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  internalStateFiles,
  type RuntimeStateFile,
} from '@openhermit/shared';

export interface TelegramAdapterConfig {
  /** Telegram bot token from @BotFather. */
  botToken: string;
  /** Connection mode: polling (dev) or webhook (prod). */
  mode: 'polling' | 'webhook';
  /** Agent connection: either explicit URL+token or auto-discover via agentId. */
  agentBaseUrl: string;
  agentToken: string;
  /** Webhook settings (only used in webhook mode). */
  webhookUrl?: string;
  webhookPort?: number;
  /** Polling interval in milliseconds (default 1000). */
  pollingInterval?: number;
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

export const loadConfig = async (): Promise<TelegramAdapterConfig> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required.');
  }

  const mode =
    (process.env.TELEGRAM_MODE as 'polling' | 'webhook') ?? 'polling';

  let agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  let agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  // Auto-discover from runtime.json if explicit URL not provided.
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

  const config: TelegramAdapterConfig = {
    botToken,
    mode,
    agentBaseUrl,
    agentToken,
  };

  if (process.env.TELEGRAM_WEBHOOK_URL) {
    config.webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  }
  if (process.env.TELEGRAM_WEBHOOK_PORT) {
    config.webhookPort = Number.parseInt(process.env.TELEGRAM_WEBHOOK_PORT, 10);
  }
  if (process.env.TELEGRAM_POLLING_INTERVAL) {
    config.pollingInterval = Number.parseInt(process.env.TELEGRAM_POLLING_INTERVAL, 10);
  }

  return config;
};
