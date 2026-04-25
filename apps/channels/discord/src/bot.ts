import { ChannelType, Events, type Message } from 'discord.js';

import type { DiscordApi, DiscordMessageEvent } from './discord-api.js';
import type { DiscordBridge } from './bridge.js';

export interface BotOptions {
  botToken: string;
  discord: DiscordApi;
  bridge: DiscordBridge;
  logger?: (message: string) => void;
}

export class DiscordBot {
  private readonly discord: DiscordApi;
  private readonly bridge: DiscordBridge;
  private readonly botToken: string;
  private readonly log: (message: string) => void;

  constructor(options: BotOptions) {
    this.discord = options.discord;
    this.bridge = options.bridge;
    this.botToken = options.botToken;
    this.log = options.logger ?? ((msg: string) => console.log(`[discord-bot] ${msg}`));
  }

  async start(): Promise<void> {
    this.discord.client.on(Events.MessageCreate, (message: Message) => {
      void this.handleMessage(message);
    });

    await this.discord.login(this.botToken);
    this.log(`connected as ${this.discord.botUsername} (${this.discord.botUserId})`);
  }

  async stop(): Promise<void> {
    await this.discord.destroy();
    this.log('bot stopped');
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.content) return;

    const isDm = message.channel.type === ChannelType.DM;
    const mentioned = isDm || this.isMentioned(message);
    const text = this.stripMention(message.content);

    if (mentioned && (text === 'new' || text === '/new')) {
      try {
        await this.bridge.handleNewSession(message.channelId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`error handling /new: ${msg}`);
      }
      return;
    }

    const event: DiscordMessageEvent = {
      channelId: message.channelId,
      userId: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.displayName ?? message.author.username,
      text,
      messageId: message.id,
      isDm,
      mentioned,
      ...(message.guildId ? { guildId: message.guildId } : {}),
    };

    try {
      await this.bridge.handleMessage(event);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`error handling message in ${message.channelId}: ${msg}`);
      if (mentioned) {
        try {
          await message.reply('Sorry, something went wrong. Please try again.');
        } catch { /* ignore */ }
      }
    }
  }

  private isMentioned(message: Message): boolean {
    const botId = this.discord.botUserId;
    if (!botId) return false;
    return message.mentions.users.has(botId);
  }

  private stripMention(text: string): string {
    const botId = this.discord.botUserId;
    if (!botId) return text;
    return text.replace(new RegExp(`<@!?${botId}>\\s*`, 'g'), '').trim();
  }
}
