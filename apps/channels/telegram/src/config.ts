export interface TelegramAdapterConfig {
  /** Telegram bot token from @BotFather. */
  botToken: string;
  /** Connection mode: polling (dev) or webhook (prod). */
  mode: 'polling' | 'webhook';
  /** Agent connection. */
  agentBaseUrl: string;
  agentToken: string;
  /** Webhook settings (only used in webhook mode). */
  webhookUrl?: string;
  webhookPort?: number;
  /** Polling interval in milliseconds (default 1000). */
  pollingInterval?: number;
}

export const loadConfig = async (): Promise<TelegramAdapterConfig> => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is required.');
  }

  const mode =
    (process.env.TELEGRAM_MODE as 'polling' | 'webhook') ?? 'polling';

  const agentBaseUrl = process.env.OPENHERMIT_AGENT_URL ?? '';
  const agentToken = process.env.OPENHERMIT_AGENT_TOKEN ?? '';

  if (!agentBaseUrl || !agentToken) {
    throw new Error(
      'Agent connection required. Set OPENHERMIT_AGENT_URL + OPENHERMIT_AGENT_TOKEN.',
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
