import {
  Client,
  GatewayIntentBits,
  type Message,
} from 'discord.js';

export interface DiscordMessageEvent {
  channelId: string;
  userId: string;
  username: string;
  displayName: string;
  text: string;
  messageId: string;
  isDm: boolean;
  guildId?: string;
}

export class DiscordApi {
  readonly client: Client;
  private ready = false;

  constructor(token: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.once('ready', () => {
      this.ready = true;
    });
  }

  get botUserId(): string | undefined {
    return this.client.user?.id;
  }

  get botUsername(): string | undefined {
    return this.client.user?.username;
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  async destroy(): Promise<void> {
    this.client.destroy();
  }

  async sendMessage(channelId: string, text: string): Promise<Message> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} not found or not text-based`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (channel as any).send(text) as Promise<Message>;
  }

  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = await (channel as any).messages.fetch(messageId);
      await msg.edit(text);
    } catch { /* ignore edit failures */ }
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = await (channel as any).messages.fetch(messageId);
      await msg.delete();
    } catch { /* ignore */ }
  }

  async startTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (channel as any).sendTyping();
      }
    } catch { /* ignore */ }
  }
}
