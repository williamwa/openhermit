/**
 * Channel launcher — starts configured channel adapters after the agent API is ready.
 * Uses dynamic imports so the agent doesn't hard-depend on specific channel packages.
 */

import type { ChannelsConfig } from './core/types.js';

export interface ChannelContext {
  agentBaseUrl: string;
  agentToken: string;
  logger: (message: string) => void;
}

interface ChannelHandle {
  name: string;
  stop: () => Promise<void>;
}

export const startChannels = async (
  channels: ChannelsConfig | undefined,
  context: ChannelContext,
): Promise<ChannelHandle[]> => {
  if (!channels) return [];

  const handles: ChannelHandle[] = [];

  if (channels.telegram?.enabled) {
    const handle = await startTelegram(channels.telegram, context);
    if (handle) handles.push(handle);
  }

  return handles;
};

export const stopChannels = async (handles: ChannelHandle[]): Promise<void> => {
  for (const handle of handles) {
    try {
      await handle.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[channels] error stopping ${handle.name}: ${message}`);
    }
  }
};

async function startTelegram(
  config: NonNullable<ChannelsConfig['telegram']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const { logger } = context;

  try {
    const { TelegramApi, TelegramBridge, TelegramBot } = await import(
      '@openhermit/channel-telegram'
    );

    const api = new TelegramApi(config.bot_token);
    const bridge = new TelegramBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentToken,
    }, logger);

    const botOptions: ConstructorParameters<typeof TelegramBot>[0] = {
      botToken: config.bot_token,
      bridge,
      mode: config.mode ?? 'polling',
      logger,
    };
    if (config.webhook_url) botOptions.webhookUrl = config.webhook_url;
    if (config.webhook_port) botOptions.webhookPort = config.webhook_port;

    const bot = new TelegramBot(botOptions);
    await bot.start();

    return {
      name: 'telegram',
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`failed to start telegram channel: ${message}`);
    return undefined;
  }
}
