/**
 * Channel launcher — starts configured channel adapters after the agent API is ready.
 * Uses dynamic imports so the agent doesn't hard-depend on specific channel packages.
 */

import type { ChannelOutbound } from '@openhermit/protocol';

import type { ChannelsConfig } from './core/types.js';

export interface ChannelContext {
  agentBaseUrl: string;
  agentTokens: Record<string, string>;
  logger: (channel: string, message: string) => void;
}

export interface ChannelHandle {
  name: string;
  outbound?: ChannelOutbound;
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

  if (channels.slack?.enabled) {
    const handle = await startSlack(channels.slack, context);
    if (handle) handles.push(handle);
  }

  if (channels.discord?.enabled) {
    const handle = await startDiscord(channels.discord, context);
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

async function startDiscord(
  config: NonNullable<ChannelsConfig['discord']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('discord', msg);

  try {
    const { DiscordApi, DiscordBridge, DiscordBot } = await import(
      '@openhermit/channel-discord'
    );

    const api = new DiscordApi(config.bot_token);
    const bridge = new DiscordBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentTokens['discord'] ?? '',
    }, log);

    const bot = new DiscordBot({
      botToken: config.bot_token,
      discord: api,
      bridge,
      logger: log,
    });

    await bot.start();

    return {
      name: 'discord',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start discord channel: ${message}`);
    return undefined;
  }
}

async function startSlack(
  config: NonNullable<ChannelsConfig['slack']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('slack', msg);

  try {
    const { SlackApi, SlackBridge, SlackBot } = await import(
      '@openhermit/channel-slack'
    );

    const api = new SlackApi(config.bot_token);
    const bridge = new SlackBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentTokens['slack'] ?? '',
    }, log);

    const bot = new SlackBot({
      appToken: config.app_token,
      slack: api,
      bridge,
      logger: log,
    });

    await bot.start();

    return {
      name: 'slack',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start slack channel: ${message}`);
    return undefined;
  }
}

async function startTelegram(
  config: NonNullable<ChannelsConfig['telegram']>,
  context: ChannelContext,
): Promise<ChannelHandle | undefined> {
  const log = (msg: string) => context.logger('telegram', msg);

  try {
    const { TelegramApi, TelegramBridge, TelegramBot } = await import(
      '@openhermit/channel-telegram'
    );

    const api = new TelegramApi(config.bot_token);
    const bridge = new TelegramBridge(api, {
      baseUrl: context.agentBaseUrl,
      token: context.agentTokens['telegram'] ?? '',
    }, log);

    const botOptions: ConstructorParameters<typeof TelegramBot>[0] = {
      botToken: config.bot_token,
      bridge,
      mode: config.mode ?? 'polling',
      logger: log,
    };
    if (config.webhook_url) botOptions.webhookUrl = config.webhook_url;
    if (config.webhook_port) botOptions.webhookPort = config.webhook_port;

    const bot = new TelegramBot(botOptions);
    await bot.start();

    return {
      name: 'telegram',
      outbound: bridge,
      stop: () => bot.stop(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start telegram channel: ${message}`);
    return undefined;
  }
}
