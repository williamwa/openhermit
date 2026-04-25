# Channel Adapter Design

## Overview

Channel adapters connect external messaging platforms (Telegram, Slack, Discord, etc.) to OpenHermit agents. Adapters are built-in processes launched by the gateway when configured and enabled.

## Architecture

```
Platform (Telegram, Slack, Discord)
    ↕ platform protocol (webhook / polling / websocket)
[Channel Adapter]  ← launched by gateway
    ↕ OpenHermit SDK (AgentLocalClient)
[Agent API]  ← existing HTTP + SSE endpoints
```

Each adapter is a **SDK client** that uses `AgentLocalClient` to interact with the agent:

- `openSession()` — create or resume a session
- `postMessage()` — send user messages (triggers agent response based on routing rules)
- `appendMessage()` — append a message to session log without triggering agent
- SSE stream — receive agent responses (text_delta, text_final, tool events, agent_end)
- `submitApproval()` — handle tool approval requests

## Implemented Adapters

| Platform | Package | Connection | Status |
|----------|---------|------------|--------|
| Telegram | `@openhermit/channel-telegram` | Polling or webhook | Stable |
| Discord | `@openhermit/channel-discord` | Gateway websocket (discord.js) | Stable |
| Slack | `@openhermit/channel-slack` | Socket Mode (app-level token) | Stable |

## Session Mapping

Each platform conversation maps to an OpenHermit session:

| Platform | Session key | Source type |
|----------|-------------|-------------|
| Telegram | `tg:{chatId}` | `group` (group chats) or `dm` (private chats) |
| Discord | `discord:{channelId}` | `group` (guild channels) or `dm` (DMs) |
| Slack | `slack:{channelId}` | `group` (channels) or `dm` (direct messages) |

The adapter calls `openSession()` on first contact with a new conversation, then reuses the session for subsequent messages.

## Message Flow

### Inbound (platform → agent)

1. Adapter receives message from platform
2. Adapter maps chat/channel ID to session ID
3. `client.openSession({ sessionId, source })` — ensure session exists
4. `client.postMessage(sessionId, { text, sender, mentioned })` — send with routing metadata
5. Server stores message in session log (all messages, regardless of routing decision)
6. Server publishes `user_message` SSE event for real-time cross-channel visibility
7. Server applies group chat routing rules (see below)
8. If triggered: adapter opens SSE stream, accumulates response, sends back to platform
9. If not triggered: adapter does nothing further

### Outbound (agent → platform)

The adapter translates agent responses into platform format:

- `text_final` → platform text message
- Long responses → split into multiple messages (platform-specific limits)
- `<NO_REPLY>` → silently discarded, no message sent to platform
- Errors → error message to user

### Approval Handling

When `tool_approval_required` arrives via SSE, the adapter auto-approves (current behavior for all channel adapters).

## Group Chat Routing

The agent runtime applies unified routing rules for all channels in `postMessage()`:

### Rules

1. **Owner messages** — always trigger agent response, regardless of mention status. If not mentioned, message is prefixed with `[not directed at you]` so the agent has context.
2. **Non-owner, mentioned** — triggers agent response.
3. **Non-owner, not mentioned** — message is stored in session log but does NOT trigger agent response. No tokens consumed.
4. **`<NO_REPLY>` mechanism** — even when triggered, the agent may respond with exactly `<NO_REPLY>` to decline replying. All bridges detect this and silently discard it instead of sending to the platform.

### Message Storage

All messages from all users are stored in the session log regardless of routing decisions. This ensures:
- Complete conversation history for context
- Owner can review all group activity
- Agent has full context when it does respond

### System Prompt

In group sessions, the agent receives a "Group Reply Policy" section in its system prompt instructing it:
- Always respond when mentioned or replied to
- For `[not directed at you]` messages, only respond if genuinely useful
- Otherwise respond with `<NO_REPLY>`

## Real-Time Cross-Channel Visibility

When a message arrives from any channel, the agent runtime publishes a `user_message` SSE event:

```typescript
{ type: 'user_message', sessionId: string, text: string, name?: string }
```

This allows the web UI (and any other SSE/WebSocket client) to see messages from Telegram, Discord, and Slack in real-time without polling.

The web UI deduplicates its own messages using a `pendingSentTexts` buffer to avoid showing web-originated messages twice.

## Configuration

Channels are configured in the agent's `config.json` under `channels`:

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

Secrets (bot tokens) are stored separately in `secrets.json` and interpolated at load time via `${{SECRET_NAME}}` placeholders.

## Runtime Management

Channels can be managed at runtime via the web UI (Manage → Channels) or gateway API:

- **Enable/Disable** — starts or stops the channel process immediately without restarting the gateway
- **Configure** — updates secrets and config.json
- **Remove** — removes channel from config entirely
- **Status tracking** — each channel reports `connected` or `error` with error details

### Gateway API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/agents/:id/channels` | GET | List all channels with status |
| `/api/agents/:id/channels/:ch/enable` | POST | Enable and start channel |
| `/api/agents/:id/channels/:ch/disable` | POST | Disable and stop channel |
| `/api/agents/:id/channels/:ch` | PUT | Configure channel secrets |
| `/api/agents/:id/channels/:ch` | DELETE | Remove channel configuration |

## Platform-Specific Notes

### Telegram

- Uses Telegram Bot API directly via `fetch` (no SDK library)
- Supports polling (development) and webhook (production) modes
- Streaming responses via `editMessageText` (throttled ~1/second)
- Rate limits: ~30 msgs/sec across chats, ~20 msgs/min per chat

### Discord

- Uses discord.js v14 with gateway intents
- DMs handled via raw gateway dispatch (`MESSAGE_CREATE` packets) due to discord.js not reliably emitting `MessageCreate` for DMs
- Group messages handled via standard `MessageCreate` event with mention detection
- Requires: `GuildMessages`, `MessageContent`, `DirectMessages` intents

### Slack

- Uses Socket Mode (requires app-level token `xapp-...` + bot token `xoxb-...`)
- Event deduplication: Slack sends both `message` and `app_mention` for @mentions; deduplicated using `event.ts` timestamp
- Supports DMs and channel messages
- Mention detection via `event.text` containing bot user ID
