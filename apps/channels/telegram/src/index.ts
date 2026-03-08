import { AgentLocalClient } from '@cloudmind/sdk';

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

console.info('[cloudmind-channel-telegram] scaffold present, implementation pending.');
