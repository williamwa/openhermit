# Telegram Channel Adapter

Connects a Telegram bot to an OpenHermit agent via the standard agent API.

## Features

- Polling and webhook connection modes
- Session-per-chat routing (`tg:{chatId}`)
- Identity extraction (chat_id, username, first_name) with auto-guest creation
- `/start` and `/new` commands
- Streaming responses via message editing (throttled to respect rate limits)
- Mention detection in group chats
- Outbound message sending (agent → Telegram)

## Configuration

In the agent's `config.json`:

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

Set the bot token as a secret:

```bash
hermit config secrets set TELEGRAM_BOT_TOKEN <token>
```

## Structure

```
src/
  bot.ts            — Telegram bot (polling + webhook modes)
  bridge.ts         — message bridge: Telegram ↔ Agent API
  telegram-api.ts   — Telegram Bot API client (direct HTTP, no SDK)
```

## See Also

- [Channel Adapter Design](../../../docs/channel-adapter.md)
