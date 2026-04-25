# Discord Channel Adapter

`@openhermit/channel-discord` connects Discord messages to a gateway-managed OpenHermit agent.

## Features

- Discord gateway connection via `discord.js`
- current-session-per-channel routing using generated `discord:{date}-{random}` session IDs plus `discord_channel_id` metadata
- guild channel and DM support
- mention-aware group routing
- sender identity extraction from Discord user IDs and display names
- optional `allowed_channel_ids` allow-list
- outbound delivery for `session_send`

## Configuration

```json
{
  "channels": {
    "discord": {
      "enabled": true,
      "bot_token": "${{DISCORD_BOT_TOKEN}}",
      "allowed_channel_ids": ["1234567890"]
    }
  }
}
```

```bash
hermit config secrets set DISCORD_BOT_TOKEN <token>
```

The bot needs message content access and the gateway intents required for guild messages and direct messages.

See [../../../docs/channel-adapter.md](../../../docs/channel-adapter.md).
