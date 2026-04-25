# Transport Protocol

The gateway exposes agent execution under `/agents/{agentId}`. All agent routes require a valid auth context unless explicitly noted. Admin bearer tokens, user JWTs, and channel tokens are all accepted by the auth resolver where appropriate.

## Auth

| Flow | Endpoint / token | Use |
|------|------------------|-----|
| Admin bearer | `Authorization: Bearer $GATEWAY_ADMIN_TOKEN` | agent lifecycle, admin APIs, full agent route access |
| Device JWT | `POST /agents/{agentId}/auth/token` | browser/web user auth |
| Channel bearer | generated or configured channel token | built-in/external channel adapters scoped to an agent/channel namespace |

Protected agents require `agent_token` during device-token exchange.

## Agent Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | gateway health |
| `GET` | `/agents` | list registered agents, admin only |
| `POST` | `/agents` | create an agent, admin only |
| `GET` | `/agents/{agentId}/health` | running/stopped health |
| `POST` | `/agents/{agentId}/manage/{start|stop|restart|delete}` | lifecycle, admin only |
| `POST` | `/agents/{agentId}/sessions` | open or resume a session |
| `GET` | `/agents/{agentId}/sessions` | list visible sessions |
| `POST` | `/agents/{agentId}/sessions/{sessionId}/messages` | post a message |
| `GET` | `/agents/{agentId}/sessions/{sessionId}/messages` | read history |
| `DELETE` | `/agents/{agentId}/sessions/{sessionId}` | delete a non-running direct session |
| `POST` | `/agents/{agentId}/sessions/{sessionId}/approve` | answer a pending tool approval |
| `POST` | `/agents/{agentId}/sessions/{sessionId}/checkpoint` | run session introspection checkpoint |
| `GET` | `/agents/{agentId}/sessions/{sessionId}/events` | durable SSE event stream |
| `WS` | `/agents/{agentId}/ws` | WebSocket RPC and event subscription |

Session list filters:

- `kind`
- `platform`
- `interactive=true|false`
- `limit`
- `channel`
- `metadata.{key}=value`

Channel tokens are namespace-scoped. A channel token with namespace `telegram` can only access session IDs prefixed with `telegram:`.

## Session Payloads

Open session:

```json
{
  "sessionId": "cli:default",
  "source": {
    "kind": "cli",
    "interactive": true,
    "platform": "cli",
    "type": "direct"
  },
  "metadata": {
    "username": "william"
  }
}
```

Post message:

```json
{
  "text": "Summarize this repo",
  "sender": {
    "channel": "cli",
    "channelUserId": "william",
    "displayName": "William"
  },
  "mentioned": true,
  "metadata": {}
}
```

Attachments are supported as `{ "type": "...", "url": "...", "data": "..." }`.

## Message Modes

### Fire And Forget

```http
POST /agents/main/sessions/cli%3Adefault/messages
```

Returns after the message is accepted:

```json
{ "sessionId": "cli:default", "messageId": "msg-...", "triggered": true }
```

### Append/Inject

```http
POST /agents/main/sessions/telegram%3A123/messages?append=true
```

Stores the message and publishes `user_message` without triggering the agent. `inject=true` is accepted as an alias.

### Wait

```http
POST /agents/main/sessions/cli%3Adefault/messages?wait=true&timeout=300000
```

Returns one JSON result when the turn ends:

```json
{
  "sessionId": "cli:default",
  "messageId": "msg-...",
  "text": "Done.",
  "toolCalls": [
    { "tool": "web_search", "isError": false, "text": "..." }
  ]
}
```

If group routing decides not to trigger the model, the response includes `triggered: false`.

### Inline SSE Stream

```http
POST /agents/main/sessions/cli%3Adefault/messages?stream=true
```

The response is an SSE stream. A `message_ack` frame may be emitted first, followed by normal outbound events until `agent_end`.

### Durable Events

```http
GET /agents/main/sessions/cli%3Adefault/events
```

This emits backlog events first, then live events, with `ready` and periodic `ping` frames.

## Outbound Events

Current event types:

- `thinking_delta`
- `thinking_final`
- `text_delta`
- `text_final`
- `tool_call`
- `tool_result`
- `tool_approval_required`
- `channel_message_sent`
- `user_message`
- `agent_end`
- `error`

Events are persisted in `session_events` and broadcast through the in-memory `SessionEventBroker`.

## WebSocket

Connect to:

```text
ws://127.0.0.1:4000/agents/main/ws?token=<jwt-or-admin-token>
```

Supported methods:

- `session.open`
- `session.message`
- `session.approve`
- `session.checkpoint`
- `session.delete`
- `session.list`
- `session.history`
- `session.subscribe`
- `session.unsubscribe`

Requests are JSON-RPC-like:

```json
{
  "id": "1",
  "method": "session.message",
  "params": {
    "sessionId": "web:device",
    "message": { "text": "Hello" }
  }
}
```

Responses are either:

```json
{ "id": "1", "result": { "sessionId": "web:device" } }
```

or:

```json
{ "id": "1", "error": { "code": "validation_error", "message": "..." } }
```

Subscribed events are delivered as server messages containing the session ID, event ID, and event payload.

## Management APIs

Owner or admin routes:

- `/api/agents/{agentId}/info`
- `/api/agents/{agentId}/config`
- `/api/agents/{agentId}/secrets`
- `/api/agents/{agentId}/skills`
- `/api/agents/{agentId}/mcp-servers`
- `/api/agents/{agentId}/channels`
- `/api/agents/{agentId}/schedules`

Admin routes:

- `/api/admin/stats`
- `/api/admin/logs`
- `/api/admin/skills`
- `/api/admin/mcp-servers`
- `/api/admin/schedules`

See the focused docs for payload details:

- [skills.md](skills.md)
- [mcp-servers.md](mcp-servers.md)
- [channel-adapter.md](channel-adapter.md)
- [session-model.md](session-model.md)
