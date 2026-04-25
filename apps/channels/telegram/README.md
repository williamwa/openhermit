# Telegram Channel Adapter

`@openhermit/channel-telegram` connects a Telegram bot to a gateway-managed OpenHermit agent.

## Features

- polling or webhook mode
- current-session-per-chat routing using generated `telegram:{date}-{random}` session IDs plus `telegram_chat_id` metadata
- private chat and group chat support
- sender identity extraction from Telegram user metadata
- auto-guest creation through the agent runtime's user resolver
- `/start` and `/new`
- mention-aware group routing
- streamed response edits with Telegram rate-limit throttling
- outbound agent-to-Telegram delivery for `session_send`

## Configuration

Add the channel to an agent's `config.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "bot_token": "${{TELEGRAM_BOT_TOKEN}}",
      "mode": "polling"
    }
  }
}
```

Store the token separately:

```bash
hermit config secrets set TELEGRAM_BOT_TOKEN <token>
```

Optional keys:

- `mode`: `polling` or `webhook`
- `webhook_url`: public webhook URL
- `webhook_port`: local webhook listener port
- `allowed_chat_ids`: allow-list of chat IDs

## Structure

```text
src/
  bot.ts            # Telegram Bot API polling/webhook loop
  bridge.ts         # Telegram <-> OpenHermit session bridge
  formatting.ts     # Markdown/plain text formatting
  telegram-api.ts   # Direct Telegram Bot API client
```

See [../../../docs/channel-adapter.md](../../../docs/channel-adapter.md).
