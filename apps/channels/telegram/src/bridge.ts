/**
 * Bridge between Telegram messages and the OpenHermit agent API.
 * Translates Telegram updates into agent session interactions.
 */

import { randomUUID } from 'node:crypto';

import { AgentLocalClient, parseSseFrames } from '@openhermit/sdk';
import type { ChannelOutbound, ChannelOutboundResult } from '@openhermit/protocol';

import type { TelegramApi, TelegramMessage, TelegramUser } from './telegram-api.js';
import {
  formatAgentResponse,
  markdownToTelegramHtml,
  streamingMarkdownToTelegramHtml,
} from './formatting.js';

/** Sentinel value the agent can return to suppress a reply in group chats. */
const NO_REPLY_TAG = '<NO_REPLY>';

/** Collected result of an agent turn. */
interface TurnResult {
  text: string | undefined;
  error: string | undefined;
}

export class TelegramBridge implements ChannelOutbound {
  readonly channel = 'telegram';

  private readonly client: AgentLocalClient;
  private readonly clientToken: string;
  private readonly log: (message: string) => void;
  /** Tracks last event ID per session for SSE deduplication. */
  private readonly lastEventIds = new Map<string, number>();
  /** Current sessionId per chat. */
  private readonly chatSessions = new Map<number, string>();
  /** Bot user info, lazily fetched via getMe(). */
  private botInfo: TelegramUser | undefined;

  constructor(
    private readonly telegram: TelegramApi,
    clientOptions: { baseUrl: string; token: string },
    logger?: (message: string) => void,
  ) {
    this.client = new AgentLocalClient(clientOptions);
    this.clientToken = clientOptions.token;
    this.log = logger ?? ((msg: string) => console.log(`[telegram-bridge] ${msg}`));
  }

  /** Lazily fetch and cache bot user info. */
  private async getBotInfo(): Promise<TelegramUser> {
    if (!this.botInfo) {
      this.botInfo = await this.telegram.getMe();
    }
    return this.botInfo;
  }

  /** Check whether a message mentions or replies to the bot. */
  private async isMentioned(message: TelegramMessage): Promise<boolean> {
    const bot = await this.getBotInfo();

    // Reply to the bot's message
    if (message.reply_to_message?.from?.id === bot.id) {
      return true;
    }

    // @mention in text entities
    if (message.entities && bot.username) {
      const botUsername = bot.username.toLowerCase();
      for (const entity of message.entities) {
        if (
          entity.type === 'mention' &&
          message.text
        ) {
          const mentionText = message.text
            .slice(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          if (mentionText === `@${botUsername}`) {
            return true;
          }
        }
        // text_mention: when user has no username, Telegram uses this with a user object
        if (entity.type === 'text_mention' && entity.user?.id === bot.id) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Send a message to a Telegram chat via the Bot API.
   * Implements `ChannelOutbound.send()`. The caller is responsible for
   * recording the `channel_message_sent` session event (the tool does this
   * via the store; the bridge reply path already has the assistant message
   * recorded by the agent runtime).
   */
  async send(params: { sessionId: string; to: string; text: string }): Promise<ChannelOutboundResult> {
    const chatId = Number(params.to);
    if (Number.isNaN(chatId)) {
      return { success: false, error: `Invalid Telegram chat ID: ${params.to}` };
    }

    try {
      const chunks = formatAgentResponse(params.text);
      let lastMessageId: number | undefined;
      for (const chunk of chunks) {
        const sent = await this.telegram.sendMessage(chatId, chunk.text, { parseMode: chunk.parseMode });
        lastMessageId = sent.message_id;
      }

      const result: ChannelOutboundResult = { success: true };
      if (lastMessageId !== undefined) result.messageId = String(lastMessageId);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`failed to send message to chat ${chatId}: ${message}`);
      return { success: false, error: message };
    }
  }

  private static generateSessionId(): string {
    return `telegram:${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  }

  /** Get or create the current sessionId for a chat. */
  private async getSessionId(chatId: number): Promise<string> {
    const cached = this.chatSessions.get(chatId);
    if (cached) return cached;

    // Try to recover the most recent session for this chat from the server.
    try {
      const sessions = await this.client.listSessions({
        channel: 'telegram',
        metadata: { telegram_chat_id: String(chatId) },
        limit: 1,
      });
      if (sessions.length > 0) {
        const sessionId = sessions[0]!.sessionId;
        this.chatSessions.set(chatId, sessionId);
        return sessionId;
      }
    } catch {
      // Server unavailable — fall through to generate a new session.
    }

    const sessionId = TelegramBridge.generateSessionId();
    this.chatSessions.set(chatId, sessionId);
    return sessionId;
  }

  /** Handle an incoming Telegram message. */
  async handleMessage(message: TelegramMessage): Promise<void> {
    const chatId = message.chat.id;
    const text = message.text?.trim();

    if (!text) {
      return; // Ignore non-text messages for now.
    }

    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';

    // Handle commands.
    if (text === '/start') {
      await this.handleStart(chatId, message, isGroup);
      return;
    }

    if (text === '/new') {
      await this.handleNew(chatId);
      return;
    }

    // Regular message — send to agent.
    const sessionId = await this.getSessionId(chatId);
    await this.sendToAgent(chatId, sessionId, text, message, isGroup);
  }

  private async handleStart(
    chatId: number,
    message: TelegramMessage,
    isGroup: boolean,
  ): Promise<void> {
    const displayName =
      message.from?.first_name ?? message.from?.username ?? 'there';

    const sessionId = await this.getSessionId(chatId);
    await this.ensureSession(sessionId, message, isGroup);
    await this.telegram.sendMessage(
      chatId,
      `Hello ${displayName}! I'm ready. Send me a message to get started.\n\nUse /new to start a fresh conversation.`,
    );
  }

  private async handleNew(
    chatId: number,
  ): Promise<void> {
    const oldSessionId = await this.getSessionId(chatId);

    // Checkpoint the current session before starting a new one.
    try {
      await this.client.checkpointSession(oldSessionId, { reason: 'new_session' });
    } catch {
      // Session may not exist yet — that's fine.
    }
    this.lastEventIds.delete(oldSessionId);

    // Generate a fresh sessionId for this chat.
    const newSessionId = TelegramBridge.generateSessionId();
    this.chatSessions.set(chatId, newSessionId);

    await this.telegram.sendMessage(chatId, 'New conversation started.');
  }

  private async sendToAgent(
    chatId: number,
    sessionId: string,
    text: string,
    message: TelegramMessage,
    isGroup: boolean,
  ): Promise<void> {
    const mentioned = isGroup ? await this.isMentioned(message) : true;

    await this.ensureSession(sessionId, message, isGroup);

    const displayName = message.from?.first_name || message.from?.username;
    const senderPayload = message.from
      ? {
          sender: {
            channel: 'telegram' as const,
            channelUserId: String(message.from.id),
            ...(displayName ? { displayName } : {}),
          },
        }
      : {};

    const postResult = await this.client.postMessage(sessionId, { text, mentioned, ...senderPayload });

    if (!(postResult as any).triggered) return;

    void this.telegram.sendChatAction(chatId).catch(() => undefined);

    const result = await this.waitForAgentResponse(sessionId, chatId);

    if (result.error && !result.text) {
      await this.telegram.sendMessage(chatId, `Error: ${result.error}`);
    } else if (result.text) {
      await this.send({ sessionId, to: String(chatId), text: result.text });
    }
  }

  private async ensureSession(
    sessionId: string,
    message?: TelegramMessage,
    isGroup = false,
  ): Promise<void> {
    const metadata: Record<string, string | number> = {};

    if (message) {
      metadata.telegram_chat_id = message.chat.id;

      if (isGroup) {
        // Group sessions: include chat title, not individual sender info
        if (message.chat.title) {
          metadata.telegram_chat_title = message.chat.title;
        }
      } else {
        // Direct sessions: include sender info for session-level identity resolution
        if (message.from?.id) {
          metadata.telegram_user_id = message.from.id;
        }
        if (message.from?.username) {
          metadata.telegram_username = message.from.username;
        }
        if (message.from?.first_name) {
          metadata.telegram_first_name = message.from.first_name;
        }
      }
    }

    await this.client.openSession({
      sessionId,
      source: {
        kind: 'channel',
        interactive: true,
        platform: 'telegram',
        type: isGroup ? 'group' : 'direct',
      },
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  /**
   * Open the SSE event stream and collect the agent's response for one turn.
   * Supports streaming edits: sends an initial message on first text_delta,
   * then periodically edits it as more text arrives.
   */
  private async waitForAgentResponse(
    sessionId: string,
    chatId: number,
  ): Promise<TurnResult> {
    const eventsUrl = this.client.buildEventsUrl(sessionId);
    const lastEventId = this.lastEventIds.get(sessionId) ?? 0;

    const response = await fetch(eventsUrl, {
      headers: { authorization: `Bearer ${this.clientToken}` },
    });

    if (!response.ok || !response.body) {
      return {
        text: undefined,
        error: `Failed to open event stream (${response.status})`,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let nextLastEventId = lastEventId;
    let accumulatedText = '';
    let finalText: string | undefined;
    let error: string | undefined;

    // Streaming edit state.
    let sentMessageId: number | undefined;
    let lastEditTime = 0;
    const EDIT_THROTTLE_MS = 1500;

    // Keep typing indicator alive.
    const typingInterval = setInterval(() => {
      void this.telegram.sendChatAction(chatId).catch(() => undefined);
    }, 4_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.remainder;
        let sawAgentEnd = false;

        for (const frame of parsed.frames) {
          if (frame.id !== undefined && frame.id <= nextLastEventId) {
            continue;
          }
          if (frame.id !== undefined) {
            nextLastEventId = frame.id;
          }

          if (frame.event === 'ready' || frame.event === 'ping') {
            continue;
          }

          const payload =
            frame.data.length > 0
              ? (JSON.parse(frame.data) as Record<string, unknown>)
              : {};

          if (frame.event === 'text_delta') {
            accumulatedText += String(payload.text ?? '');

            // Streaming edit: send initial message or throttled edits.
            const now = Date.now();
            if (!sentMessageId && accumulatedText.length > 0) {
              try {
                const html = streamingMarkdownToTelegramHtml(accumulatedText);
                const sent = await this.telegram.sendMessage(
                  chatId,
                  html + ' ...',
                  { parseMode: 'HTML' },
                );
                sentMessageId = sent.message_id;
                lastEditTime = now;
              } catch {
                // If send fails, we'll send the final text at the end.
              }
            } else if (
              sentMessageId &&
              now - lastEditTime >= EDIT_THROTTLE_MS
            ) {
              const html = streamingMarkdownToTelegramHtml(accumulatedText);
              void this.telegram
                .editMessageText(chatId, sentMessageId, html + ' ...', { parseMode: 'HTML' })
                .catch(() => undefined);
              lastEditTime = now;
            }
            continue;
          }

          if (frame.event === 'text_final') {
            finalText = String(payload.text ?? '').trim();
            continue;
          }

          if (frame.event === 'error') {
            error = String(payload.message ?? 'Unknown error');
            continue;
          }

          if (frame.event === 'agent_end') {
            sawAgentEnd = true;
            continue;
          }

          // tool_call, tool_result — skip for now.
        }

        if (sawAgentEnd) break;
      }
    } finally {
      clearInterval(typingInterval);
      await reader.cancel().catch(() => undefined);
    }

    this.lastEventIds.set(sessionId, nextLastEventId);

    const responseText = finalText ?? (accumulatedText.trim() || undefined);

    // Agent chose not to reply (group chat, not mentioned).
    if (responseText && responseText.trim() === NO_REPLY_TAG) {
      if (sentMessageId) {
        // Delete the partially-streamed message.
        void this.telegram.deleteMessage(chatId, sentMessageId).catch(() => undefined);
      }
      return { text: undefined, error: undefined };
    }

    // Final edit to show complete text with HTML formatting (remove trailing " ...").
    if (sentMessageId && responseText) {
      try {
        const html = markdownToTelegramHtml(responseText);
        await this.telegram.editMessageText(chatId, sentMessageId, html, { parseMode: 'HTML' });
      } catch {
        // HTML parse failed — fall back to plain text.
        void this.telegram
          .editMessageText(chatId, sentMessageId, responseText)
          .catch(() => undefined);
      }
    }

    return {
      text: sentMessageId ? undefined : responseText, // If we already streamed, don't send again.
      error,
    };
  }
}
