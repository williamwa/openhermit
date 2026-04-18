/**
 * Minimal Telegram Bot API client. Uses fetch directly — no external library needed.
 * Only implements the methods we actually use.
 */

const BASE_URL = 'https://api.telegram.org';

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export class TelegramApi {
  private readonly baseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `${BASE_URL}/bot${botToken}`;
  }

  private async call<T>(
    method: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(signal ? { signal } : {}),
    };
    if (params) {
      init.body = JSON.stringify(params);
    }
    const response = await fetch(`${this.baseUrl}/${method}`, init);

    const body = (await response.json()) as TelegramApiResponse<T>;

    if (!body.ok) {
      throw new Error(
        `Telegram API error (${method}): ${body.description ?? 'unknown error'}`,
      );
    }

    return body.result;
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe');
  }

  async getUpdates(
    offset?: number,
    timeout = 30,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>('getUpdates', {
      ...(offset !== undefined ? { offset } : {}),
      timeout,
      allowed_updates: ['message'],
    }, signal);
  }

  async sendMessage(
    chatId: number,
    text: string,
    options?: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' },
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    });
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    options?: { parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML' },
  ): Promise<TelegramMessage | true> {
    return this.call<TelegramMessage | true>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
    });
  }

  async sendChatAction(
    chatId: number,
    action: 'typing' = 'typing',
  ): Promise<boolean> {
    return this.call<boolean>('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  async setWebhook(url: string): Promise<boolean> {
    return this.call<boolean>('setWebhook', {
      url,
      allowed_updates: ['message'],
    });
  }

  async deleteWebhook(): Promise<boolean> {
    return this.call<boolean>('deleteWebhook');
  }
}
