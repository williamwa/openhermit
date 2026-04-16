# Transport Protocol Design

This document defines the three-layer transport model for OpenHermit agent communication.

## Motivation

The current architecture uses HTTP+SSE: POST endpoints for client→server actions, a separate GET SSE stream for server→client events. This works but has limitations:

- No synchronous "send message, wait for result" mode — callers must open a separate SSE connection and correlate events
- The approval gate is inherently bidirectional but split across two channels (SSE + HTTP POST)
- Gateway/proxy must handle two connection types separately
- Reconnection requires manual event ID tracking, backlog replay, and deduplication

After analyzing competing projects:

- **Claude Code** uses stdio (subprocess JSON, no streaming, sync by default)
- **Hermes Agent** uses HTTP+SSE with OpenAI-compatible API (`stream: true/false`)
- Neither uses WebSocket

The key insight: different callers need different transport modes. Automation scripts want sync HTTP. Simple integrations want SSE. Interactive clients (CLI, web) benefit from WebSocket.

## Three-Layer Transport Model

| Layer | Transport | Use Case |
|-------|-----------|----------|
| **HTTP sync** | `POST /sessions/:id/messages?wait=true` | Automation, cron jobs, API integrations, Telegram webhooks — send command, block until complete |
| **HTTP stream** | `POST /sessions/:id/messages?stream=true` | Inline SSE in POST response — no separate event connection needed |
| **SSE** | `GET /sessions/:id/events` (existing) | Browser EventSource, simple clients, backward compatibility |
| **WebSocket** | `ws://host/ws` | Interactive sessions — CLI, web chat, approval flow, multi-session on one connection |

All four modes share the same `SessionEventBroker` internally. The agent runner publishes events identically regardless of transport.

## HTTP Sync Mode

### Request

```
POST /sessions/:sessionId/messages?wait=true
Content-Type: application/json
Authorization: Bearer {token}

{
  "text": "run the migration",
  "messageId": "optional-client-id"
}
```

### Response

The server blocks until the agent turn completes (`agent_end`), then returns a structured result:

```typescript
interface SyncResponse {
  sessionId: string;
  messageId?: string;
  text: string | null;         // final assistant text, null if error-only
  toolCalls: SyncToolCall[];   // ordered list of all tool executions
  error?: string;              // if the turn ended with an error
}

interface SyncToolCall {
  tool: string;
  args?: unknown;
  isError: boolean;
  text?: string;
  details?: unknown;
}
```

Example response:

```json
{
  "sessionId": "cron:daily-deploy",
  "text": "Migration completed successfully. 3 tables updated.",
  "toolCalls": [
    { "tool": "exec", "args": { "command": "npm run migrate" }, "isError": false, "text": "Applied 2 migrations" },
    { "tool": "exec", "args": { "command": "npm test" }, "isError": false, "text": "42 tests passed" }
  ]
}
```

### Timeout

Default 300 seconds. If the agent doesn't complete within the timeout, the server returns 504 with partial results collected so far.

### Implementation

1. Call `runtime.postMessage(sessionId, message)` to kick off the async agent run
2. Subscribe to `runtime.events` for the session
3. Accumulate `tool_result` → `toolCalls[]`, `text_final` → `text`, `error` → `error`
4. On `agent_end`, unsubscribe and return `SyncResponse`

This reuses the existing event broker — no changes to the agent runner.

## HTTP Stream Mode

### Request

```
POST /sessions/:sessionId/messages?stream=true
Content-Type: application/json
Authorization: Bearer {token}

{
  "text": "explain this code"
}
```

### Response

The response is an SSE stream embedded in the POST response body. Events use the existing `OutboundEvent` types:

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache

event: tool_requested
data: {"type":"tool_requested","sessionId":"s1","tool":"exec","args":{"command":"cat main.ts"}}

event: tool_result
data: {"type":"tool_result","sessionId":"s1","tool":"exec","isError":false,"text":"..."}

event: text_delta
data: {"type":"text_delta","sessionId":"s1","text":"This code "}

event: text_delta
data: {"type":"text_delta","sessionId":"s1","text":"defines a "}

event: text_final
data: {"type":"text_final","sessionId":"s1","text":"This code defines a..."}

event: agent_end
data: {"type":"agent_end","sessionId":"s1"}
```

The stream closes after `agent_end`. No backlog replay, no heartbeat — the stream is scoped to a single turn.

### Implementation

1. Call `runtime.postMessage(sessionId, message)`
2. Subscribe to events
3. Use `streamSSE()` to write events inline in the POST response
4. On `agent_end`, close the stream

## SSE (Existing — Retained)

The existing `GET /sessions/:sessionId/events` endpoint remains unchanged for backward compatibility.

- Long-lived connection with 15-second heartbeat pings
- Backlog replay on connect (last 100 events)
- `ready` event on connection established
- Clients track `lastEventId` for deduplication on reconnect

No changes planned. This will be eventually deprecated once WebSocket is stable and all clients have migrated.

## WebSocket Protocol

### Endpoint

```
Agent:   ws://{host}:{port}/ws?token={bearer_token}
Gateway: ws://{host}:{port}/agents/{agentId}/ws?token={bearer_token}
```

Token is validated during the HTTP upgrade handshake. Rejected with 401 if invalid.

### Connection Scoping

A WebSocket connection is **not** scoped to a single session. One connection can manage multiple sessions. Every message includes `sessionId` to route correctly.

### Ping / Pong

WebSocket protocol-level ping/pong frames (30-second interval) replace the application-level SSE heartbeat.

### Message Framing

All messages are JSON text frames with a common envelope:

```typescript
interface WsMessage {
  kind: 'request' | 'response' | 'event';
  id?: string;          // present on request and response
  sessionId?: string;   // present on most messages
}
```

| Kind | Direction | Purpose |
|------|-----------|---------|
| `request` | client → server | RPC call expecting a response |
| `response` | server → client | Reply to a specific request (matched by `id`) |
| `event` | server → client | Streaming event (no reply expected) |

### Client → Server Requests

#### `session.open`

```typescript
{ kind: 'request', id: '1', method: 'session.open',
  params: { sessionId: string, source: SessionSource, metadata?: Record<string, MetadataValue> } }
// Response: { kind: 'response', id: '1', result: { sessionId: string } }
```

Replaces: `POST /sessions`

#### `session.message`

```typescript
{ kind: 'request', id: '2', method: 'session.message',
  params: { sessionId: string, text: string, messageId?: string, attachments?: SessionAttachment[] } }
// Response: { kind: 'response', id: '2', result: { sessionId: string, messageId?: string } }
```

Agent output streams back as events on the same connection.

Replaces: `POST /sessions/:sessionId/messages`

#### `session.approve`

```typescript
{ kind: 'request', id: '3', method: 'session.approve',
  params: { sessionId: string, toolCallId: string, approved: boolean } }
// Response: { kind: 'response', id: '3', result: { resolved: boolean } }
```

Replaces: `POST /sessions/:sessionId/approve`

#### `session.checkpoint`

```typescript
{ kind: 'request', id: '4', method: 'session.checkpoint',
  params: { sessionId: string, reason?: 'manual' | 'new_session' | 'turn_limit' | 'idle' } }
// Response: { kind: 'response', id: '4', result: { checkpointed: boolean } }
```

Replaces: `POST /sessions/:sessionId/checkpoint`

#### `session.list`

```typescript
{ kind: 'request', id: '5', method: 'session.list',
  params?: { kind?: SourceKind, platform?: string, interactive?: boolean, limit?: number } }
// Response: { kind: 'response', id: '5', result: SessionSummary[] }
```

Replaces: `GET /sessions`

#### `session.history`

```typescript
{ kind: 'request', id: '6', method: 'session.history',
  params: { sessionId: string } }
// Response: { kind: 'response', id: '6', result: SessionHistoryMessage[] }
```

Replaces: `GET /sessions/:sessionId/messages`

#### `session.subscribe`

Subscribe to events for a session. Server sends backlog events after `lastEventId`, then live events.

```typescript
{ kind: 'request', id: '7', method: 'session.subscribe',
  params: { sessionId: string, lastEventId?: number } }
// Response: { kind: 'response', id: '7', result: { subscribed: true } }
```

Replaces: `GET /sessions/:sessionId/events` (SSE connection)

#### `session.unsubscribe`

```typescript
{ kind: 'request', id: '8', method: 'session.unsubscribe',
  params: { sessionId: string } }
// Response: { kind: 'response', id: '8', result: { unsubscribed: true } }
```

No SSE equivalent — previously required closing the connection entirely.

### Server → Client Events

Existing `OutboundEvent` types wrapped in WS envelope:

```typescript
{
  kind: 'event',
  eventId: number,        // monotonic, same as SSE event ID
  sessionId: string,
  event: OutboundEvent    // text_delta, text_final, tool_requested, etc.
}
```

The `OutboundEvent` union remains exactly as-is.

### Error Handling

Request errors return `error` instead of `result`:

```typescript
{
  kind: 'response',
  id: string,
  error: { code: WsErrorCode, message: string }
}
```

| Code | Meaning |
|------|---------|
| `INVALID_PARAMS` | Malformed or missing parameters |
| `SESSION_NOT_FOUND` | Session does not exist |
| `NOT_SUBSCRIBED` | Unsubscribe called for non-subscribed session |
| `UNAUTHORIZED` | Token invalid |
| `INTERNAL_ERROR` | Unexpected server error |

### Reconnection

On disconnect, client reconnects and re-sends `session.subscribe` with `lastEventId` for each session. Server replays missed events from backlog.

## Event Broker Enhancement

Add `subscribeFrom()` to `SessionEventBroker` for atomic subscribe + backlog replay:

```typescript
subscribeFrom(
  sessionId: string,
  afterEventId: number,
  subscriber: SessionSubscriber,
): () => void
```

This method atomically: (1) attaches the subscriber, (2) replays backlog events with `id > afterEventId`. Eliminates the theoretical race between `getBacklog()` and `subscribe()`. Used by WebSocket subscribe and refactored into the existing SSE endpoint.

## HTTP Endpoints Retained

Read-only endpoints remain as plain HTTP alongside all transport modes:

- `GET /health`
- `GET /sessions` — session listing
- `GET /sessions/:id/messages` — message history
- `GET /sessions/:id/events` — SSE stream (retained for compatibility)

## Gateway Considerations

The gateway proxies all transport modes:

- **HTTP sync/stream**: query params pass through naturally, gateway streams POST response body for `?stream=true`
- **SSE**: existing proxy logic unchanged
- **WebSocket**: on `upgrade` to `/agents/{agentId}/ws`, validate gateway token, resolve agent port, bidirectional WS frame proxy

## TypeScript Types

All new types added to `packages/protocol/src/index.ts`:

```typescript
// --- HTTP sync response ---
export interface SyncToolCall {
  tool: string;
  args?: unknown;
  isError: boolean;
  text?: string;
  details?: unknown;
}

export interface SyncResponse {
  sessionId: string;
  messageId?: string;
  text: string | null;
  toolCalls: SyncToolCall[];
  error?: string;
}

// --- WebSocket messages ---
export type WsMethod =
  | 'session.open'
  | 'session.message'
  | 'session.approve'
  | 'session.checkpoint'
  | 'session.list'
  | 'session.history'
  | 'session.subscribe'
  | 'session.unsubscribe';

export interface WsRequest {
  kind: 'request';
  id: string;
  method: WsMethod;
  params?: Record<string, unknown>;
}

export interface WsResponseOk {
  kind: 'response';
  id: string;
  result: unknown;
}

export interface WsResponseError {
  kind: 'response';
  id: string;
  error: { code: WsErrorCode; message: string };
}

export type WsResponse = WsResponseOk | WsResponseError;

export type WsErrorCode =
  | 'INVALID_PARAMS'
  | 'SESSION_NOT_FOUND'
  | 'NOT_SUBSCRIBED'
  | 'UNAUTHORIZED'
  | 'INTERNAL_ERROR';

export interface WsEvent {
  kind: 'event';
  eventId: number;
  sessionId: string;
  event: OutboundEvent;
}

export type WsServerMessage = WsResponse | WsEvent;
export type WsClientMessage = WsRequest;
```

## SDK Surface

```typescript
// AgentLocalClient additions
async postMessageSync(sessionId, message): Promise<SyncResponse>
async postMessageStream(sessionId, message): AsyncIterable<OutboundEvent>

// New class
class AgentWsClient {
  constructor(options: { url: string; token: string });
  connect(): Promise<void>;
  close(): void;
  // RPC methods
  sessionOpen(params): Promise<{ sessionId: string }>;
  sessionMessage(params): Promise<{ sessionId: string; messageId?: string }>;
  sessionApprove(params): Promise<{ resolved: boolean }>;
  sessionCheckpoint(params): Promise<{ checkpointed: boolean }>;
  sessionList(params?): Promise<SessionSummary[]>;
  sessionHistory(params): Promise<SessionHistoryMessage[]>;
  // Subscription
  subscribe(sessionId, lastEventId?): Promise<void>;
  unsubscribe(sessionId): Promise<void>;
  // Events
  on(event: 'event', handler: (event: WsEvent) => void): void;
  on(event: 'close', handler: () => void): void;
  on(event: 'error', handler: (error: Error) => void): void;
}
```

## Implementation Status

### Phase 1: HTTP Sync + Stream ✅ Completed

1. ✅ `SyncResponse`, `SyncToolCall` types added to protocol
2. ✅ `subscribeFrom()` added to `SessionEventBroker`
3. ✅ POST messages handler supports `?wait=true` and `?stream=true`
4. ✅ `postMessageSync`, `postMessageStream` added to SDK
5. ✅ Gateway proxy detects streaming POST responses and streams through
6. ✅ Tests for sync, stream, backward compat

Implementation notes:
- Event subscription is established *before* `postMessage()` to handle both sync runtimes (InMemoryAgentRuntime) and async runtimes (AgentRunner)
- Stream mode buffers events during `postMessage()` and flushes them once the SSE stream is ready
- Default timeout for sync mode: 300 seconds, configurable via `?timeout=N`

### Phase 2: WebSocket Endpoint ✅ Completed

1. ✅ WS types added to protocol (`WsRequest`, `WsResponse`, `WsEvent`, `WsMethod`, `WsErrorCode`)
2. ✅ `ws` dependency added to agent and gateway
3. ✅ `ws-handler.ts` — handles all 8 WS methods
4. ✅ WS server attached to HTTP server via `upgrade` event in `index.ts`
5. ✅ `AgentWsClient` added to SDK (browser-compatible WebSocket client)
6. ✅ `isWsRequest()` validator added to protocol

### Phase 3: CLI Migration

1. Adopt `?stream=true` for `waitForAssistantTurn` (quick win)
2. Later: migrate to `AgentWsClient`

### Phase 4: Gateway WS Proxy ✅ Completed

1. ✅ `ws` added to gateway
2. ✅ `ws-proxy.ts` handles `upgrade` for `/agents/:agentId/ws`
3. ✅ Bidirectional frame proxy with close/error propagation

### Phase 5: Web Migration + SSE Deprecation

1. Replace browser EventSource with WebSocket
2. Remove SSE endpoint after all clients migrated

## Comparison with Current Protocol

| Current (HTTP+SSE) | New | Notes |
|---------------------|-----|-------|
| `POST messages` → fire-and-forget | `POST messages` → fire-and-forget | Default unchanged |
| (not available) | `POST messages?wait=true` → `SyncResponse` | New sync mode |
| (not available) | `POST messages?stream=true` → inline SSE | New stream mode |
| `GET events` (SSE) | `GET events` (SSE) | Retained |
| (not available) | `ws://host/ws` | New WS transport |
| SSE `ready` event | WS `subscribe` response | Subscribe ack |
| SSE `ping` 15s | WS protocol ping/pong 30s | No app-level heartbeat |
| One SSE per session | One WS, multi-session | More efficient |
| HTTP status codes | WS `error` in response | Structured codes |
