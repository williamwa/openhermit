# Channel Adapters

OpenHermit includes built-in Telegram, Discord, and Slack adapters. The gateway starts enabled adapters for each running agent and registers scoped channel tokens so adapters can call back into `/agents/{agentId}/...`.

## Implemented Adapters

| Platform | Package | Connection |
|----------|---------|------------|
| Telegram | `@openhermit/channel-telegram` | polling or webhook |
| Discord | `@openhermit/channel-discord` | Discord gateway via `discord.js` |
| Slack | `@openhermit/channel-slack` | Slack Socket Mode |

## Session Routing

Adapters keep a current session per external conversation and recover it by listing sessions with channel metadata.

| Platform | Generated session prefix | Metadata used for recovery |
|----------|--------------------------|----------------------------|
| Telegram | `telegram:` | `telegram_chat_id` |
| Discord | `discord:` | `discord_channel_id` |
| Slack | `slack:` | `slack_channel_id`, optional `slack_thread_ts` |

`/new` creates a new generated session ID after checkpointing the previous session with reason `new_session`.

## Message Flow

1. Platform event arrives.
2. Adapter resolves or creates the current OpenHermit session.
3. Adapter calls `openSession()` with source metadata.
4. Adapter calls `postMessage()` with text, `sender`, and `mentioned`.
5. Runtime persists the message and emits `user_message`.
6. Runtime applies group routing.
7. If triggered, adapter reads SSE events until `agent_end`.
8. Adapter sends or edits platform messages from the final response.

## Group Routing

The runtime applies channel-agnostic group behavior:

- owners always trigger the agent
- non-owner mentioned messages trigger the agent
- non-owner unmentioned messages are logged but do not trigger a model turn
- exact `<NO_REPLY>` final responses are suppressed by adapters

## Outbound Messages

Adapters register `ChannelOutbound` implementations. The `session_send` tool can send proactive messages through them, and the runtime records `channel_message_sent`.

## Configuration

Channels live under `channels` in the agent config. Secrets should be stored in `secrets.json` and referenced with `${{SECRET_NAME}}`.

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "bot_token": "${{TELEGRAM_BOT_TOKEN}}",
      "mode": "polling"
    },
    "discord": {
      "enabled": true,
      "bot_token": "${{DISCORD_BOT_TOKEN}}"
    },
    "slack": {
      "enabled": true,
      "bot_token": "${{SLACK_BOT_TOKEN}}",
      "app_token": "${{SLACK_APP_TOKEN}}"
    }
  }
}
```

## Runtime Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/agents/{agentId}/channels` | list configured channels and status |
| `POST` | `/api/agents/{agentId}/channels/{channelId}/enable` | enable and start |
| `POST` | `/api/agents/{agentId}/channels/{channelId}/disable` | disable and stop |
| `PUT` | `/api/agents/{agentId}/channels/{channelId}` | update config/secrets |
| `DELETE` | `/api/agents/{agentId}/channels/{channelId}` | remove config |

These routes require owner or admin auth.

## Platform Notes

Telegram:

- direct Bot API client
- polling and webhook modes
- throttled message edits for streaming output
- optional `allowed_chat_ids`

Discord:

- `discord.js` v14
- guild messages and DMs
- mention detection before routing
- optional `allowed_channel_ids`

Slack:

- Socket Mode with bot token plus app token
- channel, DM, and thread metadata
- deduplicates paired message/app-mention events
- optional `allowed_channel_ids`
