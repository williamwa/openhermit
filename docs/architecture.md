# System Architecture

## Core Concept

**Agent runs on the host. Docker containers are tools the agent controls.**

The agent process itself lives on the host machine. It has one dedicated workspace directory where all its state, memory, files, and container data live. The agent never touches anything outside this workspace (except binding container ports to the host network for services).

When the agent needs to run code, install dependencies, or provide a service — it launches a Docker container, mounts the relevant subdirectory from its own workspace, and interacts with it. Containers are disposable; the agent and its workspace are persistent.

---

## High-Level Diagram

```
CLI user ──► cloudmind CLI ──────────────────────────────────┐
                                                              │ HTTP (localhost)
Telegram user ──► Telegram Bot API                           │
                       │ long-poll                            │
              ┌────────▼───────────────┐                     │
              │  Telegram Bridge       │                      │
              │  (service container,   │─── host.docker. ────┤
              │   agent-managed)       │    internal:PORT     │
              └────────────────────────┘                      │
Scheduler / Cron ─────────────────────────────────────────────┤
                                                              ▼
                                              ┌───────────────────────────┐
                                              │  Agent Process            │
                                              │  HTTP API (Hono)          │
                                              │  POST /sessions            │
                                              │  POST /sessions            │
                                              │ /{sessionId}/messages      │
                                              │  GET  /events              │
                                              │         (SSE stream)       │
                                              └──────────────┬────────────┘
                                                             │
                                              ┌──────────────▼────────────┐
                                              │  Core                     │
                                              │  Session Router           │
                                              │  pi-agent-core (LLM loop) │
                                              │  Memory Manager           │
                                              │  Container Manager        │
                                              │  Hook System              │
                                              │  Scheduler (optional)     │
                                              └──────────────┬────────────┘
                                                             │
                                              ┌──────────────▼────────────┐
                                              │  Workspace (filesystem)   │
                                              └──────────────┬────────────┘
                                                             │
                                              ┌──────────────▼────────────┐
                                              │  Docker Daemon            │
                                              └────┬──────────────┬───────┘
                                                   │              │
                                       ┌───────────▼──┐  ┌────────▼─────────┐
                                       │  Ephemeral   │  │  Service         │
                                       │  Container   │  │  Container       │──► port:host
                                       └──────────────┘  └──────────────────┘
```

---

## Workspace Structure

Every agent gets one workspace directory. Everything the agent owns lives here.

```
~/.cloudmind/{agent-id}/                 # ← OUTSIDE workspace (agent cannot read/modify)
├── security.json                        # autonomy_level + require_approval_for (tamper-resistant)
└── secrets.json                         # API keys, tokens, passwords (values NEVER exposed to LLM)

{workspace_root}/                        # e.g., ~/cloudmind/agents/{agent-id}/
│
├── config.json                          # Agent identity, model, schedule, and hooks config
│
├── identity/                            # Who the agent is (agent reads; user edits)
│   ├── IDENTITY.md                      # Agent's name, role, backstory
│   ├── SOUL.md                          # Core personality, values, communication style
│   ├── USER.md                          # Who the agent is helping (user profile)
│   └── AGENTS.md                        # Behavior guidelines and operating rules
│
├── memory/
│   ├── working.md                       # Rolling context summary (what agent "has in mind" right now)
│   ├── long-term.md                     # Long-term memory index / table of contents
│   ├── heartbeat.md                     # Periodic task checklist, maintained by the agent itself
│   ├── episodic/
│   │   ├── 2026-03.jsonl                # Append-only event log, split by month
│   │   └── 2026-04.jsonl
│   └── notes/                           # Long-term knowledge files indexed from long-term.md
│       ├── facts.md
│       ├── user-preferences.md
│       └── {topic}.md
│
├── sessions/
│   └── {YYYY-MM-DD}-{session-id}.jsonl  # Per-session conversation log (messages + tool calls)
│
├── containers/
│   ├── registry.jsonl                   # Record of all containers ever created by this agent
│   └── {container-name}/
│       └── data/                        # Files to be mounted into this container (agent writes here, container reads)
│
├── files/                               # Agent's general working files (code, docs, artifacts)
│
├── hooks/
│   └── hooks.json                       # Custom hook handler declarations (optional)
│
├── runtime/
│   ├── api.token                        # Runtime API token (generated at startup, gitignored)
│   └── api.port                         # Actual bound port (written at startup, read by CLI + bridges)
│
└── logs/
    └── {YYYY-MM-DD}.log                 # Agent runtime logs
```

**Note on `~/.cloudmind/{agent-id}/`**: This directory is intentionally stored **outside the workspace**. The agent has write/delete access to its workspace — if security policy or secrets lived inside, the agent could modify or remove its own permission boundaries or read credential values directly. Both files in this directory are read by the agent process at startup but never written to by the agent. Only the user (or deployment scripts) should edit them.

### Key Principles
- The agent **only reads, writes, and deletes within its workspace**
- Container mounts **only point to subdirs under `containers/{name}/data/`**
- All paths go through three-layer validation before use (see Security Policy §5)
- Sessions are immutable once written (append-only)
- Memory files are the only files the agent actively mutates over time
- Security policy and secrets live **outside** the workspace and are never writable by the agent
- The LLM sees secret **names** only, never values — values are injected into containers at runtime

---

## Components

### 1. Agent Process (Host)

The agent is a long-running process on the host. It:
- Exposes a simple interface (CLI or local API) for sending messages
- Delegates LLM calls and loop management to `pi-agent-core`
- Provides all custom tools (container, memory, workspace, etc.)
- Reads/writes memory files via the Memory Manager
- Calls the Docker SDK to manage containers via Dockerode
- Streams output back to the caller via pi-agent-core's event system

It does **not** run inside Docker. It is a plain Node.js process.

### 2. LLM Core (pi-ai + pi-agent-core)

CloudMind does **not** implement its own ReAct loop. It uses two libraries from the `pi-mono` ecosystem:

```
@mariozechner/pi-ai          — unified multi-provider LLM API
@mariozechner/pi-agent-core  — stateful agent loop with tool execution + events
```

#### Layer diagram

```
CloudMind Tool Handlers
  (container_run, file_search, read_file, …)
           │ implements AgentTool[]
           ▼
  @mariozechner/pi-agent-core
  ┌──────────────────────────────────────────┐
  │  Agent { state, prompt(), subscribe() }  │
  │  • multi-turn tool-calling loop          │
  │  • streaming events                      │
  │  • transformContext() → inject memory    │
  │  • abort / resume / model-switch         │
  └──────────────┬───────────────────────────┘
                 │ calls stream() / complete()
                 ▼
  @mariozechner/pi-ai
  ┌──────────────────────────────────────────┐
  │  getModel(provider, model)               │
  │  Anthropic · OpenAI · Google · Mistral   │
  │  Groq · Bedrock · OpenRouter · Ollama …  │
  │  TypeBox tool schemas · cost tracking    │
  └──────────────────────────────────────────┘
```

#### How pi-agent-core events map to CloudMind hooks

| pi-agent-core event | CloudMind hook point |
|--------------------|---------------------|
| `agent_start` | `onSessionStart` |
| `agent_end` | `onSessionEnd` |
| `tool_execution_start` | `beforeToolCall` |
| `tool_execution_end` | `afterToolCall` |
| *(subscriber pre-prompt)* | `beforeInbound` |
| *(subscriber pre-agent_end)* | `beforeOutbound` |
| *(scheduler pre-dispatch)* | `onScheduleTrigger` |
| *(error in subscriber)* | `onError` |

Most hook handlers subscribe to pi-agent-core events; `onScheduleTrigger` is fired by the scheduler just before it dispatches a non-interactive trigger into the runner.

#### Context injection via `transformContext`

pi-agent-core's `transformContext` callback runs before every LLM turn. CloudMind uses it to:
1. Inject `identity/*.md` files into the system prompt (once per session)
2. Inject `memory/working.md` as a system context block
3. Trim / summarise history if approaching token budget

```typescript
const agent = new Agent({
  initialState: { model: getModel('anthropic', 'claude-opus-4-5'), tools },
  transformContext: async (messages) =>
    injectWorkingMemory(await injectIdentity(messages)),
})
```

#### Multi-provider and model switching

```typescript
// Switch provider mid-session (e.g. fallback on rate-limit)
agent.setModel(getModel('openai', 'gpt-4o'))

// Use local Ollama
agent.setModel(getModel('openai-compatible', 'llama3.1', {
  baseUrl: 'http://localhost:11434/v1',
}))

// Heartbeat uses a cheaper/faster model
const heartbeatAgent = new Agent({
  initialState: { model: getModel('anthropic', 'claude-haiku-4-5'), tools: heartbeatTools },
})
```

#### Tool definition format (TypeBox via pi-ai)

```typescript
import { Type } from '@mariozechner/pi-ai'
import type { AgentTool } from '@mariozechner/pi-agent-core'

const containerRunTool: AgentTool = {
  name: 'container_run',
  description: 'Run a command in an ephemeral Docker container',
  parameters: Type.Object({
    image:   Type.String({ description: 'Docker image, e.g. python:3.12-slim' }),
    command: Type.String({ description: 'Shell command to execute' }),
    description: Type.Optional(Type.String({ description: 'Short note describing why this container run exists' })),
    mount:   Type.Optional(Type.String({ description: 'Validated workspace path under containers/{name}/data/' })),
  }),
  execute: async (args) => {
    // The tool layer enforces autonomy policy and validates mount paths first.
    return containerManager.runEphemeral(args)   // CloudMind container module
  },
}
```

Built-in tools available to agent:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file within workspace |
| `write_file` | Write a file within workspace |
| `list_files` | List files in a workspace directory |
| `delete_file` | Delete a single file within workspace |
| `container_run` | Spin up an ephemeral container, run a command, return stdout/stderr/exitCode |
| `container_start` | Start a long-term service container |
| `container_stop` | Stop a service container |
| `container_exec` | Exec a command in a running container |
| `container_status` | List containers and their status |
| `file_search` | Ripgrep-like text search across workspace files |
| `web_fetch` | Fetch a URL and return content |
| `agent_doctor` | Run self-diagnostics: check process health, containers, memory files, config validity |

### 3. Memory Manager (File-based)

Four layers, all stored as plain files in the workspace:

#### Working Memory — `memory/working.md`
- A markdown file the agent rewrites as context shifts
- Contains: current task/goal, key facts relevant right now, recent decisions
- Kept short (< 1000 tokens) — agent summarizes and updates it explicitly

#### Episodic Memory — `memory/episodic/{YYYY-MM}.jsonl`
- Append-only JSONL log, one summary/event per line, **split by month** to avoid unbounded file growth
- Written by summarization, not by blindly mirroring every raw session event
- Primary triggers:
  - once when a session ends
  - once every 50 conversation turns for a long-running session
- Used for reviewing history, understanding what happened and when across sessions
- Format: `{"ts": "ISO8601", "type": "...", "session": "...", "data": {...}}`
- Current month file is active; older files are read-only archives

#### Long-Term Memory — `memory/long-term.md` + `memory/notes/*.md`
- `memory/long-term.md` is the entry point and index
- `memory/notes/*.md` contains the actual topic files linked or indexed from `long-term.md`
- Human-readable markdown, organized by topic rather than by time
- Read, write, and search are handled through normal file tools plus `file_search`
- Examples: `user-preferences.md`, `project-status.md`, `important-facts.md`

#### Session Log — `sessions/{date}-{id}.jsonl`
- Full append-only event history for a single conversation session
- Each line includes `ts`, an event role/type, and event-specific payload
- Common entries: user message, assistant thought/final answer, tool call, tool result
- Written during session, read-only after

### 4. Container Manager (Docker SDK)

Manages two container types:

#### Ephemeral Containers (short-term)
- Purpose: run code, install and test something, one-off computation
- Lifecycle: created → runs command → returns output → auto-removed (`--rm`)
- Mount: `workspace/containers/{name}/data/` → `/workspace` inside container
- No port bindings
- Resource limits: CPU + memory caps
- Example use: "run this Python script", "compile this code", "check if this npm package works"

#### Service Containers (long-term)
- Purpose: provide a running service (web server, database, background worker)
- Lifecycle: created → running → paused/resumed → explicitly stopped by agent
- Mount: `workspace/containers/{name}/data/` → `/data` inside container
- Port bindings: container port → host port (the one place host is affected)
- Recorded in `containers/registry.jsonl` with status + metadata, including a human/agent-written `description` of why the container exists
- Example use: "run a local Postgres for this project", "serve this web app on port 3000"

#### Sentinel Markers for Output Parsing

Container stdout can contain noise (package install logs, warnings, etc.). Structured output uses sentinel markers so the host can reliably extract just the result:

```
---CLOUDMIND_OUTPUT_START---
{"result": "...", "exitCode": 0}
---CLOUDMIND_OUTPUT_END---
```

Scripts that need to return structured data to the agent write to stdout between these markers. Raw stdout/stderr outside the markers is still captured and available for debugging.

#### IPC via Filesystem (for long-running containers)

Service containers communicate back to the agent by writing JSON files into a shared IPC directory:

```
containers/{name}/data/ipc/out/   ← container writes here
containers/{name}/data/ipc/in/    ← agent writes here (commands to container)
```

The agent polls `ipc/out/` on a configurable interval. This avoids the need for any ports or sockets just for agent↔container communication.

#### Container Registry — `containers/registry.jsonl`
- Each entry should include a short `description` field so either the user or the agent can record the purpose of creating that container
- `description` is free-form but should stay concise and task-oriented, e.g. "Postgres backing store for project-x" or "Ephemeral Python run for Fibonacci verification"

```jsonl
{"id": "abc123", "name": "pg-project-x", "image": "postgres:16", "type": "service", "status": "running", "description": "Postgres backing store for project-x web app", "ports": {"5432": 5432}, "mount": "containers/pg-project-x/data", "created": "2026-03-07T10:00:00Z"}
{"id": "def456", "name": "run-20260307-1", "image": "python:3.12", "type": "ephemeral", "status": "removed", "description": "Ephemeral Python run for Fibonacci verification", "created": "2026-03-07T10:05:00Z"}
```

### 5. Security Policy

The architecture already provides the primary security boundary: the agent only speaks to the host via typed tools (no raw Bash), and all file tools are hard-coded to operate within the workspace via three-layer path validation. This means there is no meaningful "host escape" surface to configure away with a list of blocked paths.

The security config (`~/.cloudmind/{agent-id}/security.json`) therefore focuses exclusively on **autonomy policy** — *what the agent is allowed to do on its own*, not *what the host allows*. It lives outside the workspace so the agent cannot modify its own permission boundaries.

#### Autonomy Levels

Three levels control how much the agent can act without asking the user:

| Level | Behaviour |
|-------|-----------|
| `readonly` | Can read files and check status, cannot write, delete, execute, or start containers. |
| `supervised` | Normal operation. Executes tools freely, but `require_approval_for` tools pause for user confirmation. **Default.** |
| `full` | Executes everything without prompting. Use only for trusted batch jobs. |

Scheduled maintenance sessions never run at `full`. Their effective autonomy is `min(security.autonomy_level, supervised)`: a globally `readonly` agent stays `readonly`; `supervised` and `full` agents both run scheduled sessions as `supervised`.

#### Path Validation — Three Layers (hardcoded, not configurable)

Every path passed to `read_file`, `write_file`, `delete_file`, `list_files`, or any container mount goes through all three checks in order. This is not a setting — it always runs:

```
1. Null byte check         path.includes('\0') → reject immediately
2. Workspace boundary      resolved = path.resolve(root, path); relative = path.relative(root, resolved); reject if relative is absolute or starts with '..'
3. Symlink escape check    realpath(target) if it exists, otherwise realpath(nearest existing ancestor); reject if canonical path escapes root
```

Layer 2 avoids unsafe lexical-prefix checks such as `/workspace` vs `/workspace-evil`. Layer 3 catches symlink attacks: a symlink inside the workspace pointing to `/etc/passwd` would pass layer 2 but fail after canonicalization. For new files and directories, canonicalizing the nearest existing ancestor preserves legitimate create/write flows while still blocking symlink escapes.

Because this boundary is architectural (not policy-driven), a separate `forbidden_paths` list would be redundant — the agent simply cannot reach `/etc`, `~/.ssh`, or any other host path regardless of configuration.

#### Container Command Safety

Commands run inside containers via `container_exec` or `container_run` execute inside Docker, not on the host. The container only has access to its mounted `containers/{name}/data/` subdirectory. Since code inside a container cannot reach host-sensitive paths, a command whitelist is an operational preference rather than a security control.

The default `container_defaults` in `config.json` sets memory + CPU caps on all containers. Raw command execution belongs in session logs; episodic memory should only receive summarized outcomes worth remembering later.

#### `~/.cloudmind/{agent-id}/security.json`

Only the fields that genuinely need tamper-resistance live here:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_start", "delete_file"]
}
```

| Field | Purpose |
|-------|---------|
| `autonomy_level` | `readonly \| supervised \| full` — controls whether the agent acts freely or requests confirmation |
| `require_approval_for` | List of tool names that always trigger the `require-approval` hook, regardless of autonomy level (for example `container_start` or `delete_file`) |

Everything else (container resource limits, command preferences) lives in `config.json` inside the workspace — it's operational config, not a security boundary.

#### `~/.cloudmind/{agent-id}/secrets.json`

Sensitive credentials the agent's containers may need at runtime. The LLM **never sees the values** — only the key names, which are injected into the system prompt as a reference list.

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "TELEGRAM_BOT_TOKEN": "...",
  "DATABASE_PASSWORD": "...",
  "GITHUB_TOKEN": "ghp_..."
}
```

**How it works**:
1. At session start, the agent process reads `secrets.json` into memory (never logs it, never passes it to the LLM)
2. The system prompt includes only the **key names**: `"Available secrets: OPENAI_API_KEY, DISCORD_BOT_TOKEN, DATABASE_PASSWORD, GITHUB_TOKEN"`
3. The LLM can reference a secret by name in a tool call: `container_run({ ..., env_secrets: ["OPENAI_API_KEY"] })`
4. The tool handler resolves the actual value from the in-memory secrets map and passes it as a Docker `--env` flag
5. The tool result returned to the LLM confirms the env var was set, but never echoes the value

This means credentials flow: `secrets.json → agent memory → Docker env var → container process`. They are never part of any message in the LLM conversation.

---

### 6. Lifecycle Hook System

A lightweight event bus that fires at fixed points in the agent's execution. Hooks let cross-cutting concerns (logging, safety checks, memory updates, approvals) be defined separately from the core loop logic.

#### Hook Points

| Hook | Fires when | Can block? |
|------|-----------|------------|
| `onSessionStart` | A new session begins | No |
| `onSessionEnd` | A session ends (normal or error) | No |
| `beforeInbound` | An inbound message payload is prepared, before the LLM sees it | Yes |
| `beforeToolCall` | LLM has chosen a tool, before execution | Yes |
| `afterToolCall` | Tool has returned its result | No |
| `beforeOutbound` | Agent is about to emit its final answer or final result | Yes |
| `onScheduleTrigger` | A scheduled non-interactive session is about to be dispatched | No |
| `onError` | An unhandled error occurs in the loop | No |

"Can block" means the hook handler can throw an error to abort the current operation (e.g., a safety hook blocking a dangerous tool call). For non-blocking hook points, handler failures are logged to `onError` and the main session continues.

#### Built-in Hook Handlers

| Handler | Hook points | What it does |
|---------|------------|--------------|
| `log` | all | Writes audit/log data; episodic memory receives summarized events rather than a full mirror of raw session traffic |
| `require-approval` | `beforeToolCall` | Pauses execution and asks user to confirm before proceeding |

#### Custom Hook Handlers — `hooks/hooks.json`

Users can declare custom hooks. Each entry maps a hook point to a list of handlers:

```json
{
  "beforeToolCall": ["require-approval"],
  "afterToolCall": ["log"],
  "onSessionEnd": ["log"],
  "onScheduleTrigger": ["log"]
}
```

In the future, custom handlers can be JS files in `hooks/` that export an async handler function.

#### How hooks integrate with the ReAct loop

```
session created
      │
inbound message arrives
      │
  [beforeInbound hooks]
      │
  LLM generates tool call
      │
  [beforeToolCall hooks]  ← can block here (e.g., require-approval)
      │
  tool executes
      │
  [afterToolCall hooks]   ← log result, scan for secrets
      │
  LLM generates final answer
      │
  [beforeOutbound hooks]
      │
  answer sent to user
      │
  [onSessionEnd hooks]    ← write session summary to episodic / working / long-term as needed
```

---

### 7. Session Lifecycle Model

Every agent session uses the same two internal primitives:

- `openSession(spec)` — create or resume a session context
- `postMessage(sessionId, message)` — append one inbound message to that session

Interactive channels and scheduled jobs are both thin adapters over these same primitives.

```typescript
type SessionSpec = {
  sessionId: string
  source: {
    kind: "cli" | "im" | "heartbeat" | "cron"
    interactive: boolean
    platform?: string
    triggerId?: string
  }
  metadata?: Record<string, string | number | boolean>
}

type SessionMessage = {
  messageId?: string
  text: string
  attachments?: { type: string; url?: string; data?: Buffer }[]
}

type OutboundEvent =
  | { type: "text_delta"; sessionId: string; text: string }
  | { type: "text_final"; sessionId: string; text: string }
  | { type: "tool_requested"; sessionId: string; tool: string; args?: unknown }
  | { type: "tool_started"; sessionId: string; tool: string; args?: unknown }
  | { type: "error"; sessionId: string; message: string }
```

#### Design intent

- The core runner only knows how to open a session and accept inbound messages; it does not know whether they came from a human, a bridge container, a timer, or a cron job
- `source.kind` captures the behavior class the core cares about; `source.platform` keeps adapter-specific detail such as `telegram`, `discord`, or `feishu`
- Interactive sources set `source.interactive = true` and typically subscribe to the SSE stream
- Scheduled sources set `source.interactive = false`; they still produce the same internal events, but results are logged rather than streamed to a caller
- The same hooks, memory injection, security policy, tool registry, and session logging apply regardless of trigger origin

#### Scheduled triggers

Heartbeat and cron jobs are just scheduled adapters over the same session lifecycle:

- Heartbeat is a built-in scheduled source that opens a session, synthesizes a first message from `memory/heartbeat.md`, and posts it
- Cron jobs are user-defined scheduled sources that open a session, synthesize their own first message, and post it
- Both dispatch through the same runner used by CLI and IM sessions
- Both are non-interactive by default and record summarized outcomes to episodic memory

#### `memory/heartbeat.md` — agent-maintained checklist

The heartbeat trigger reads this file to decide what maintenance work to perform. Example:

```markdown
# Heartbeat Checklist

## Hourly
- [ ] Verify all service containers are running — last checked: 2026-03-07 09:00
- [ ] Refresh long-running session summaries if any session crossed another 50-turn boundary

## Daily
- [ ] Summarise today's episodic log into memory/notes/daily-summary.md — last run: 2026-03-06
- [ ] Clean up ephemeral container records older than 7 days from registry

## Weekly
- [ ] Archive sessions older than 30 days
- [ ] Review memory/long-term.md and memory/notes/ for stale or contradictory facts
```

#### Scheduled config in `config.json`

```json
"heartbeat": {
  "enabled": true,
  "interval_minutes": 60,
  "max_iterations": 10,
  "tools_allowed": ["read_file", "write_file", "list_files", "file_search", "container_status"]
},
"schedules": {
  "jobs": []
}
```

- `heartbeat.interval_minutes`: how often the built-in heartbeat trigger fires
- `heartbeat.max_iterations`: cap on the ReAct loop turns for heartbeat sessions
- `heartbeat.tools_allowed`: restrict which tools heartbeat can use
- `schedules.jobs`: optional user-defined cron-style jobs that open `source.kind = "cron"` sessions and post a synthesized first message
- Effective autonomy for scheduled triggers comes from `security.json`, but is always capped at `supervised`
- If a scheduled task needs a blocked or approval-gated tool, it logs and skips rather than waiting for interactive confirmation

#### Session namespacing

Session IDs are namespaced by source:

| Source | Session ID format | Meaning |
|--------|------------------|---------|
| CLI | `cli:{YYYY-MM-DD}-{nanoid}` | Each CLI invocation |
| IM bridge (Telegram example) | `telegram:{chat_id}` | Each IM conversation, namespaced by platform |
| Heartbeat | `heartbeat:{ts}` | Each heartbeat run |
| Cron job | `cron:{job-id}:{ts}` | Each configured scheduled job run |

Sessions from different trigger sources share the same agent memory (`working.md`, `long-term.md`, `notes/`) but have separate conversation histories.

---

### 8. External Trigger Adapters

The agent exposes an HTTP API (Hono server) as its sole external communication interface. There is no `ChannelManager` class and no platform-specific channel code inside the agent process. External clients — a CLI program, a Telegram bridge container, a future web UI, or an external scheduler — all adapt into the same session lifecycle.

#### HTTP API Contract

```
POST /sessions
  Body: SessionSpec JSON
  Returns: { sessionId }

POST /sessions/{sessionId}/messages
  Body: SessionMessage JSON
  Returns: { sessionId, messageId? }

GET /events?sessionId=xxx
  Returns: SSE stream of OutboundEvent
```

These are agent-local routes. Each agent already runs on its own port, so the caller first discovers the target agent via workspace/runtime metadata (`runtime/api.port`, `runtime/api.token`) and then talks to that agent's local API directly; the URL does not repeat the agent id.

`POST /sessions` is metadata-only: it creates or resumes session state, but it does not carry user text and does not advance the agent loop on its own. The loop advances only when a `SessionMessage` is posted.

The HTTP API is one adapter over the same core runner. In-process timers and internal schedulers can call `openSession()` and `postMessage()` directly without going through HTTP.

#### Port — Dynamic Assignment

At startup the agent binds the HTTP server to port `0`, letting the OS assign a free port. The actual port is written to `runtime/api.port`. If `config.http_api.preferred_port` is set, it is tried first; if already taken, the OS assigns a free port instead.

This means multiple agents can run on the same host with zero port configuration — each agent discovers its own port via `runtime/api.port`.

HTTP API port is runtime state only: it lives in `runtime/api.port`, not `config.json` and not `containers/registry.jsonl`. Service-container port bindings are recorded separately in `containers/registry.jsonl`.

#### Auth — Runtime API Token

At startup the agent generates a random token, writes it to `runtime/api.token`, and requires it on every HTTP request (`Authorization: Bearer <token>`). The `runtime/` directory is gitignored. Bridge containers receive the token via the `CLOUDMIND_API_KEY` environment variable.

#### CLI Client

`cloudmind chat --agent <id>` and `cloudmind run --agent <id> "task"` are thin external programs. They:
1. Read `runtime/api.port` and `runtime/api.token` from the agent workspace
2. Create a session via `POST /sessions` with `source.kind = "cli"` and a session ID like `cli:{YYYY-MM-DD}-{nanoid}`
3. Subscribe to `GET /events?sessionId=xxx`
4. Send the first or next user message via `POST /sessions/{sessionId}/messages`
5. Stream `text_delta` events to stdout

#### Telegram Bridge Container

Telegram is handled by a service container the agent starts via `container_start`. The container is an independent program (any language) that:
1. Long-polls the Telegram Bot API
2. Ensures a session exists for the conversation by creating or reusing session ID `telegram:{chat_id}` with `source.kind = "im"` and `source.platform = "telegram"`
3. POSTs each inbound Telegram message to `POST /sessions/{sessionId}/messages`
4. Subscribes to the SSE stream and forwards the response back to Telegram via `sendMessage`

The bridge container is configured with these environment variables:
- `TELEGRAM_BOT_TOKEN` — injected from `secrets.json`
- `CLOUDMIND_API_URL=http://host.docker.internal:{port}` — port read from `runtime/api.port` at container launch time
- `CLOUDMIND_API_KEY` — runtime token from `runtime/api.token`
- `CLOUDMIND_AGENT_ID` — optional metadata for bridge logs/metrics; not needed for routing

`config.channels.telegram_bridge.allowed_chat_ids` — allowlist of Telegram chat IDs the bridge enforces; empty list rejects all.

#### Adding a New Trigger Adapter

Write any client or scheduler that:
1. Reads or receives the runtime API token
2. Creates or reuses a session with `SessionSpec`
3. Posts one or more inbound messages with `SessionMessage`
4. Subscribes to the SSE stream only if the source is interactive

No agent loop changes are needed.

#### Future: Optional Gateway / Control Plane

Current CloudMind is intentionally agent-local: each agent exposes its own HTTP API and manages its own runtime. A future gateway may sit above those agent-local APIs without changing the per-agent contract.

Possible gateway responsibilities:
- Provision and manage many agents from one place
- Proxy agent-local APIs behind multi-agent routes such as `/agents/{id}/sessions`, `/agents/{id}/sessions/{sessionId}/messages`, and `/agents/{id}/events`
- Own channel and trigger orchestration centrally, so Telegram bridges, heartbeat schedules, cron jobs, and future adapters attach to the gateway instead of to each agent directly
- Monitor agent process health, restart status, and reachability

This is explicitly a future control-plane layer. It is not part of the v1 agent runtime contract described in this document.

---

## Host System Impact

The agent is designed to be minimally invasive to the host. Here is the complete list of ways the host system is affected:

### Unavoidable (by design)
| Impact | Details |
|--------|---------|
| **Port bindings** | Service containers bind ports to the host. Agent tracks which ports are in use in registry. |
| **Docker daemon** | Must be running on host. Agent connects via `/var/run/docker.sock`. |

### Potentially needed (case-by-case)
| Impact | Details |
|--------|---------|
| **Firewall rules** | If a service container needs to be reachable from outside, UFW/iptables may need a rule opened. Agent can note this but cannot do it automatically (requires root). |
| **Tailscale Funnel** | Agent cannot run `tailscale funnel` directly — host networking is out of scope for agent tools. If external access via Tailscale Funnel is needed, the agent will instruct the user to run `tailscale funnel <port>` themselves. |
| **Secrets / env vars** | API keys or credentials that containers need. Stored in `~/.cloudmind/{agent-id}/secrets.json` (outside workspace). Agent reads at startup, injects as Docker `--env` flags at container launch. Values never written to container images and never passed to LLM. |
| **Docker networks** | Agent may create named Docker networks for multi-container setups. These are Docker-managed, not host-level. |
| **DNS** | If containers need to resolve custom hostnames, may need `/etc/hosts` entries on the host. Edge case. |
| **GPU access** | If a container needs GPU, host must have nvidia-container-toolkit. Not needed for v1. |
| **Auto-start on boot** | If the agent should restart on reboot, needs a systemd unit or equivalent on the host. Optional. |

### Never touched by agent
- Host filesystem outside workspace
- Host packages (apt, brew, etc.)
- Host environment variables
- Host network interfaces (except port bindings via Docker)
- Other processes on the host

---

## Config File — `config.json`

**`{workspace}/config.json`** — agent reads and can write (non-security fields only)

```json
{
  "agent_id": "agent-abc123",
  "name": "My Agent",
  "created": "2026-03-07T00:00:00Z",
  "model": {
    "provider": "anthropic",
    "model": "claude-opus-4-5",
    "max_tokens": 8192
  },
  "identity": {
    "files": ["identity/IDENTITY.md", "identity/SOUL.md", "identity/USER.md", "identity/AGENTS.md"]
  },
  "container_defaults": {
    "memory_limit": "512m",
    "cpu_shares": 512,
    "network": "bridge"
  },
  "hooks": {
    "beforeToolCall": ["log"],
    "afterToolCall": ["log"],
    "onSessionStart": ["log"],
    "onSessionEnd": ["log"],
    "onScheduleTrigger": ["log"]
  },
  "heartbeat": {
    "enabled": true,
    "interval_minutes": 60,
    "max_iterations": 10,
    "tools_allowed": ["read_file", "write_file", "list_files", "file_search", "container_status"]
  },
  "schedules": {
    "jobs": []
  },
  "http_api": {
    "preferred_port": 3000
  },
  "channels": {
    "telegram_bridge": {
      "enabled": false,
      "allowed_chat_ids": []
    }
  }
}
```

**`~/.cloudmind/{agent-id}/security.json`** — user only, agent cannot write

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_start", "delete_file"]
}
```

**`~/.cloudmind/{agent-id}/secrets.json`** — user only, agent reads at startup but never logs or passes to LLM

```json
{
  "ANTHROPIC_API_KEY": "sk-ant-...",
  "TELEGRAM_BOT_TOKEN": "...",
  "DATABASE_PASSWORD": "...",
  "GITHUB_TOKEN": "ghp_..."
}
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Agent runtime | Node.js + TypeScript |
| LLM provider abstraction | `@mariozechner/pi-ai` (Anthropic, OpenAI, Google, Ollama, OpenRouter…) |
| Agent loop | `@mariozechner/pi-agent-core` (multi-turn, tool calling, streaming events) |
| Tool schemas | TypeBox (via pi-ai) |
| Container management | Dockerode (Docker SDK for Node) |
| Memory / sessions | Plain files: `.md` + `.jsonl` |
| Database | None in v1. SQLite optional later. |
| Telegram bridge | container image (any language) |
| HTTP API | Hono (built into agent process from Phase 2) |
| Deployment | Single host process (systemd or pm2) |
