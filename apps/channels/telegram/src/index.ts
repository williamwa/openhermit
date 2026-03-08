import { AgentLocalClient } from '@openhermit/sdk';

export interface TelegramBridgeConfig {
  agentBaseUrl: string;
  agentToken: string;
  telegramBotToken: string;
}

export const createTelegramBridgeClient = (
  config: TelegramBridgeConfig,
): AgentLocalClient =>
  new AgentLocalClient({
    baseUrl: config.agentBaseUrl,
    token: config.agentToken,
  });

console.info('[openhermit-channel-telegram] scaffold present, implementation pending.');
