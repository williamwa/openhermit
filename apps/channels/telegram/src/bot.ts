/**
 * Telegram bot with polling and webhook modes.
 */

import { createServer, type Server } from 'node:http';

import { TelegramApi, type TelegramUpdate } from './telegram-api.js';
import type { TelegramBridge } from './bridge.js';

export interface BotOptions {
  botToken: string;
  bridge: TelegramBridge;
  mode: 'polling' | 'webhook';
  webhookUrl?: string;
  webhookPort?: number;
  pollingInterval?: number;
  logger?: (message: string) => void;
}

export class TelegramBot {
  private readonly api: TelegramApi;
  private readonly bridge: TelegramBridge;
  private readonly log: (message: string) => void;
  private running = false;
  private pollOffset: number | undefined;
  private pollAbort: AbortController | undefined;
  private webhookServer: Server | undefined;

  constructor(private readonly options: BotOptions) {
    this.api = new TelegramApi(options.botToken);
    this.bridge = options.bridge;
    this.log = options.logger ?? ((msg: string) => console.log(`[telegram-bot] ${msg}`));
  }

  async start(): Promise<void> {
    const me = await this.api.getMe();
    this.log(`connected as @${me.username ?? me.first_name} (${me.id})`);
    this.running = true;

    if (this.options.mode === 'webhook') {
      await this.startWebhook();
    } else {
      // Fire-and-forget: polling loop runs in background so start() resolves immediately.
      void this.startPolling();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pollAbort?.abort();

    if (this.webhookServer) {
      await new Promise<void>((resolve) => {
        this.webhookServer!.close(() => resolve());
      });
      await this.api.deleteWebhook();
      this.log('webhook server stopped');
    }

    this.log('bot stopped');
  }

  // --- Polling mode ---

  private async startPolling(): Promise<void> {
    // Ensure no stale webhook.
    await this.api.deleteWebhook();
    this.log('polling mode started');

    this.pollAbort = new AbortController();

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.pollOffset, 30, this.pollAbort.signal);
        for (const update of updates) {
          await this.handleUpdate(update);
          this.pollOffset = update.update_id + 1;
        }
      } catch (error) {
        if (!this.running) break;
        if (error instanceof DOMException && error.name === 'AbortError') break;
        const message =
          error instanceof Error ? error.message : String(error);
        this.log(`polling error: ${message}`);
        // Back off on error.
        await new Promise((resolve) => setTimeout(resolve, this.options.pollingInterval ?? 1000));
      }
    }
  }

  // --- Webhook mode ---

  private async startWebhook(): Promise<void> {
    const port = this.options.webhookPort ?? 8443;
    const url = this.options.webhookUrl;

    if (!url) {
      throw new Error('TELEGRAM_WEBHOOK_URL is required in webhook mode.');
    }

    this.webhookServer = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const update = JSON.parse(body) as TelegramUpdate;
        // Handle asynchronously — respond to Telegram immediately.
        void this.handleUpdate(update);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      this.webhookServer!.listen(port, () => resolve());
    });

    await this.api.setWebhook(url);
    this.log(`webhook mode started on port ${port} → ${url}`);
  }

  // --- Update handling ---

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (!update.message) {
      return;
    }

    try {
      await this.bridge.handleMessage(update.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.log(`error handling message from chat ${update.message.chat.id}: ${message}`);

      // Try to notify the user.
      try {
        await this.api.sendMessage(
          update.message.chat.id,
          `Sorry, something went wrong. Please try again.`,
        );
      } catch {
        // Can't even send an error message — just log.
      }
    }
  }
}
