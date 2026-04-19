# Channel Adapter Design

## Overview

Channel adapters connect external messaging platforms (Telegram, Slack, Discord, etc.) to OpenHermit agents. An adapter is an independent process that translates between platform-specific protocols and the standard OpenHermit agent API.

## Architecture

```
Platform (Telegram, Slack, ...)
    ↕ platform protocol (webhook / polling / websocket)
[Channel Adapter]  ← independent process
    ↕ OpenHermit SDK (AgentLocalClient)
[Agent API]  ← existing HTTP + SSE endpoints
```

An adapter is a **SDK client**, no different from the CLI or web client. It uses the same `AgentLocalClient` to interact with the agent:

- `openSession()` — create or resume a session
- `postMessage()` — send user messages
- SSE stream — receive agent responses (text_delta, text_final, tool events, agent_end)
- `submitApproval()` — handle tool approval requests

No new agent endpoints are needed. The adapter is a consumer of the existing API.

## Session Mapping

Each platform conversation maps to an OpenHermit session:

| Platform | Session ID | Source |
|----------|------------|--------|
| Telegram | `telegram:{date}-{random}` | `{ kind: 'channel', platform: 'telegram', interactive: true }` |
| Slack | `slack:{date}-{random}` | `{ kind: 'channel', platform: 'slack', interactive: true }` |
| Discord | `discord:{date}-{random}` | `{ kind: 'channel', platform: 'discord', interactive: true }` |

The adapter calls `openSession()` on first contact with a new conversation, then reuses the session for all subsequent messages in that conversation.

## Message Flow

### Inbound (platform → agent)

1. Adapter receives message from platform (via webhook or polling)
2. Adapter maps chat/channel ID to session ID
3. `client.openSession({ sessionId, source })` — ensure session exists
4. `client.postMessage(sessionId, { text })` — send user message
5. Open SSE stream to `client.buildEventsUrl(sessionId)` — wait for response
6. Accumulate `text_delta` events, capture `text_final`
7. On `agent_end` — close stream, send response back to platform

### Outbound (agent → platform)

The adapter translates the agent's response into platform format:

- `text_final` → platform text message
- Long responses → split into multiple messages (platform-specific limits)
- Tool events → optionally shown as status indicators
- Errors → error message to user

### Approval Handling

When `tool_approval_required` arrives via SSE:

- **Auto-approve** — adapter approves automatically (for non-interactive/trusted contexts)
- **Forward to user** — send approval prompt to the platform chat, wait for user response, call `submitApproval()`

The approval mode is configurable per adapter.

## Adapter Configuration

Each adapter reads configuration from environment variables and/or a config file:

```
# Agent connection (required)
OPENHERMIT_AGENT_URL=http://localhost:3001
OPENHERMIT_AGENT_TOKEN=<token from runtime.json>

# Or: auto-discover from runtime.json
OPENHERMIT_AGENT_ID=<agent-id>

# Platform-specific
TELEGRAM_BOT_TOKEN=<bot token from @BotFather>
```

For local development, the adapter can read `runtime.json` directly to discover the agent's port and token (same as CLI).

## Telegram Adapter

### Overview

The first channel adapter. Connects a Telegram bot to an OpenHermit agent.

### Bot Setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get the bot token
3. Configure the adapter with the token

### Connection Modes

**Polling mode** (development):
- Uses Telegram `getUpdates` long-polling API
- No public URL needed
- Simpler to develop and debug

**Webhook mode** (production):
- Telegram pushes updates to a public HTTPS endpoint
- Lower latency, more efficient
- Requires public URL (direct or via tunnel)

The adapter supports both modes, configured via environment variable:

```
TELEGRAM_MODE=polling    # default for development
TELEGRAM_MODE=webhook    # production
TELEGRAM_WEBHOOK_URL=https://example.com/telegram/webhook
TELEGRAM_WEBHOOK_PORT=8443
```

### Supported Message Types

Phase 1:
- Text messages → `postMessage({ text })`
- `/start` command → open new session, send welcome
- `/new` command → checkpoint current session, start new one

Phase 2 (future):
- Photos/documents → attachments
- Voice messages → transcription + text
- Inline keyboards for approval prompts

### Streaming Response

Telegram supports message editing. The adapter can provide a streaming experience:

1. On first `text_delta` → send initial message via `sendMessage`
2. On subsequent `text_delta` → accumulate text, periodically `editMessageText` (throttled to avoid rate limits)
3. On `text_final` → final `editMessageText` with complete text

Throttle edits to ~1 per second to stay within Telegram rate limits.

### Implementation Structure

```
apps/channels/telegram/src/
  index.ts          — entry point, arg parsing, startup
  bot.ts            — Telegram bot (polling + webhook modes)
  bridge.ts         — message bridge: Telegram ↔ Agent SDK
  config.ts         — configuration loading
  formatting.ts     — response formatting (markdown, message splitting)
```

### Dependencies

- `@openhermit/sdk` — agent client (existing)
- `@openhermit/protocol` — types (existing)
- No Telegram SDK library — use Telegram Bot API directly via `fetch` (the API is simple HTTP+JSON, no need for a wrapper library)

### Rate Limits

Telegram rate limits:
- ~30 messages/second to different chats
- ~20 messages/minute to the same chat
- Message edits: ~1/second per message

The adapter must respect these limits, especially for streaming edits.
