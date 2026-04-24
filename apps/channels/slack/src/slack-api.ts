import { WebClient } from '@slack/web-api';

export interface SlackMessageEvent {
  type: string;
  subtype?: string;
  channel: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  channel_type?: string;
}

export interface SlackBotInfo {
  id: string;
  name: string;
  user_id: string;
}

export class SlackApi {
  readonly web: WebClient;
  private botInfo: SlackBotInfo | undefined;

  constructor(botToken: string) {
    this.web = new WebClient(botToken);
  }

  async getBotInfo(): Promise<SlackBotInfo> {
    if (this.botInfo) return this.botInfo;
    const result = await this.web.auth.test();
    this.botInfo = {
      id: result.bot_id as string,
      name: result.user as string,
      user_id: result.user_id as string,
    };
    return this.botInfo;
  }

  async sendMessage(
    channel: string,
    text: string,
    options?: { threadTs?: string; mrkdwn?: boolean },
  ): Promise<{ ts: string; channel: string }> {
    const args: Record<string, unknown> = {
      channel,
      text,
      mrkdwn: options?.mrkdwn ?? true,
    };
    if (options?.threadTs) args.thread_ts = options.threadTs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await this.web.chat.postMessage(args as any);
    return { ts: result.ts as string, channel: result.channel as string };
  }

  async updateMessage(
    channel: string,
    ts: string,
    text: string,
  ): Promise<void> {
    await this.web.chat.update({ channel, ts, text });
  }

  async getUserInfo(userId: string): Promise<{ name: string; real_name?: string }> {
    const result = await this.web.users.info({ user: userId });
    const user = result.user as { name?: string; real_name?: string } | undefined;
    const info: { name: string; real_name?: string } = { name: user?.name ?? userId };
    if (user?.real_name) info.real_name = user.real_name;
    return info;
  }

  async getConversationInfo(channelId: string): Promise<{ name?: string; is_im: boolean }> {
    const result = await this.web.conversations.info({ channel: channelId });
    const ch = result.channel as { name?: string; is_im?: boolean } | undefined;
    const info: { name?: string; is_im: boolean } = { is_im: ch?.is_im ?? false };
    if (ch?.name) info.name = ch.name;
    return info;
  }
}
