# System Architecture

## Core Concept

**Agent runs on the host. Docker containers are tools the agent controls.**

The agent process itself lives on the host machine. It has one dedicated workspace directory where all its state, memory, files, and container data live. The agent never touches anything outside this workspace (except binding container ports to the host network for services).

When the agent needs to run code, install dependencies, or provide a service — it launches a Docker container, mounts the relevant subdirectory from its own workspace, and interacts with it. Containers are disposable; the agent and its workspace are persistent.

---

## High-Level Diagram

```
                    ┌─────────────────────┐
  Telegram user ───►│  Telegram Bot API   │
                    └──────────┬──────────┘
                               │ long-poll
  CLI user ────────────────────┤
  (stdin/stdout)               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ HOST MACHINE — Agent Process                                         │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  Channel Manager                                              │   │
│  │  CLI Channel · Telegram Channel · (future: HTTP, Discord…)   │   │
│  └───────────────────────┬───────────────────────────────────────┘   │
│          InboundMessage  │  OutboundEvent                            │
│                          ▼                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │  LLM Core    │  │  Memory Mgr  │  │  Container Mgr            │  │
│  │ (pi-agent-   │  │ (file-based) │  │  (Dockerode)              │  │
│  │  core)       │  │              │  │                           │  │
│  └──────┬───────┘  └──────┬───────┘  └─────────────┬─────────────┘  │
│         │                 │                        │                │
│  ┌──────┴─────────────────┴────────────────────────┴───────────┐    │
│  │  Hook System                                                │    │
│  │  onSessionStart/End · beforeToolCall · afterToolCall        │    │
│  │  beforeInbound · beforeOutbound · onHeartbeat · onError     │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Heartbeat Engine  (timer → heartbeat.md → mini session)      │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                      │                               │
│                              ┌───────▼────────┐                      │
│                              │   Workspace    │                      │
│                              │  (filesystem)  │                      │
│                              └───────┬────────┘                      │
└──────────────────────────────────────┼───────────────────────────────┘
                                       │
                            ┌──────────▼──────────┐
                            │    Docker Daemon     │
                            └───┬──────────────┬───┘
                                │              │
                    ┌───────────▼──┐    ┌───────▼──────────┐
                    │  Ephemeral   │    │  Service         │
                    │  Container   │    │  Container       │──► port:host
                    │  (run+rm)    │    │  (long-running)  │    binding
                    └──────────────┘    └──────────────────┘
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
├── config.json                          # Agent identity, model, heartbeat, hooks config
│
├── identity/                            # Who the agent is (agent reads; user edits)
│   ├── IDENTITY.md                      # Agent's name, role, backstory
│   ├── SOUL.md                          # Core personality, values, communication style
│   ├── USER.md                          # Who the agent is helping (user profile)
│   └── AGENTS.md                        # Behavior guidelines and operating rules
│
├── memory/
│   ├── working.md                       # Rolling context summary (what agent "has in mind" right now)
│   ├── heartbeat.md                     # Periodic task checklist, maintained by the agent itself
│   ├── episodic/
│   │   ├── 2026-03.jsonl                # Append-only event log, split by month
│   │   └── 2026-04.jsonl
│   └── notes/                           # Long-term knowledge, one markdown file per topic
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
└── logs/
    └── {YYYY-MM-DD}.log                 # Agent runtime logs
```

**Note on `~/.cloudmind/{agent-id}/`**: This directory is intentionally stored **outside the workspace**. The agent has `write_file` access to its workspace — if security policy or secrets lived inside, the agent could modify its own permission boundaries or read credential values directly. Both files in this directory are read by the agent process at startup but never written to by the agent. Only the user (or deployment scripts) should edit them.

### Key Principles
- The agent **only reads and writes within its workspace**
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
  (container_run, memory_note, read_file, …)
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
| *(error in subscriber)* | `onError` |

Hook handlers subscribe to pi-agent-core events; CloudMind's hook runner fires from those subscriptions.

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
    mount:   Type.Optional(Type.String({ description: 'Workspace subdir to mount' })),
  }),
  execute: async (args) => {
    security.checkCommand(args.command)          // CloudMind security layer
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
| `container_run` | Spin up an ephemeral container, run a command, return stdout/stderr/exitCode |
| `container_start` | Start a long-term service container |
| `container_stop` | Stop a service container |
| `container_exec` | Exec a command in a running container |
| `container_status` | List containers and their status |
| `memory_note` | Write/update a note in memory/notes/{topic}.md |
| `memory_recall` | Read one or more memory note files |
| `web_fetch` | Fetch a URL and return content |
| `tailscale_funnel` | Enable/disable Tailscale Funnel for a port (runs `tailscale funnel`, no sudo needed) |
| `agent_doctor` | Run self-diagnostics: check process health, containers, memory files, config validity |

### 3. Memory Manager (File-based)

Three layers, all stored as plain files in the workspace:

#### Working Memory — `memory/working.md`
- A markdown file the agent rewrites as context shifts
- Contains: current task/goal, key facts relevant right now, recent decisions
- Kept short (< 1000 tokens) — agent summarizes and updates it explicitly

#### Episodic Memory — `memory/episodic/{YYYY-MM}.jsonl`
- Append-only JSONL log, one event per line, **split by month** to avoid unbounded file growth
- Events: `message_received`, `tool_called`, `tool_result`, `session_started`, `session_ended`, `note_updated`, `heartbeat_run`, `hook_fired`
- Used for reviewing history, understanding what happened and when
- Format: `{"ts": "ISO8601", "type": "...", "session": "...", "data": {...}}`
- Current month file is active; older files are read-only archives

#### Long-term Notes — `memory/notes/*.md`
- Agent explicitly creates and updates these
- Human-readable markdown, organized by topic
- Agent uses `memory_note` tool to write and `memory_recall` to read
- Examples: `user-preferences.md`, `project-status.md`, `important-facts.md`

#### Session Log — `sessions/{date}-{id}.jsonl`
- Full message history for a single conversation session
- Each line: `{"role": "user|assistant|tool", "ts": "...", "content": "..."}`
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
- Recorded in `containers/registry.jsonl` with status + metadata
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
```jsonl
{"id": "abc123", "name": "pg-project-x", "image": "postgres:16", "type": "service", "status": "running", "ports": {"5432": 5432}, "mount": "containers/pg-project-x/data", "created": "2026-03-07T10:00:00Z"}
{"id": "def456", "name": "run-20260307-1", "image": "python:3.12", "type": "ephemeral", "status": "removed", "created": "2026-03-07T10:05:00Z"}
```

### 5. Security Policy

The architecture already provides the primary security boundary: the agent only speaks to the host via typed tools (no raw Bash), and all file tools are hard-coded to operate within the workspace via three-layer path validation. This means there is no meaningful "host escape" surface to configure away with a list of blocked paths.

The security config (`~/.cloudmind/{agent-id}/security.json`) therefore focuses exclusively on **autonomy policy** — *what the agent is allowed to do on its own*, not *what the host allows*. It lives outside the workspace so the agent cannot modify its own permission boundaries.

#### Autonomy Levels

Three levels control how much the agent can act without asking the user:

| Level | Behaviour |
|-------|-----------|
| `readonly` | Can read files and check status, cannot write, execute, or start containers. Used for heartbeat runs and audit sessions. |
| `supervised` | Normal operation. Executes tools freely, but `require_approval_for` tools pause for user confirmation. **Default.** |
| `full` | Executes everything without prompting. Use only for trusted batch jobs. |

The heartbeat engine always runs at `readonly` or `supervised` (configurable per agent), never `full`.

#### Path Validation — Three Layers (hardcoded, not configurable)

Every path passed to `read_file`, `write_file`, `list_files`, or any container mount goes through all three checks in order. This is not a setting — it always runs:

```
1. Null byte check         path.includes('\0') → reject immediately
2. Workspace boundary      resolve(workspaceRoot, path) must start with workspaceRoot
3. Symlink escape check    fs.realpathSync(resolved) must also start with workspaceRoot
```

Layer 3 catches symlink attacks: a symlink inside the workspace pointing to `/etc/passwd` would pass layer 2 but fail layer 3 after resolution.

Because this boundary is architectural (not policy-driven), a separate `forbidden_paths` list would be redundant — the agent simply cannot reach `/etc`, `~/.ssh`, or any other host path regardless of configuration.

#### Container Command Safety

Commands run inside containers via `container_exec` or `container_run` execute inside Docker, not on the host. The container only has access to its mounted `containers/{name}/data/` subdirectory. Since code inside a container cannot reach host-sensitive paths, a command whitelist is an operational preference rather than a security control.

The default `container_defaults` in `config.json` sets memory + CPU caps on all containers. Commands passed to containers are logged in the episodic memory for auditability.

#### `~/.cloudmind/{agent-id}/security.json`

Only the fields that genuinely need tamper-resistance live here:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_start", "tailscale_funnel"]
}
```

| Field | Purpose |
|-------|---------|
| `autonomy_level` | `readonly \| supervised \| full` — controls whether the agent acts freely or requests confirmation |
| `require_approval_for` | List of tool names that always trigger the `require-approval` hook, regardless of autonomy level |

Everything else (container resource limits, command preferences) lives in `config.json` inside the workspace — it's operational config, not a security boundary.

#### `~/.cloudmind/{agent-id}/secrets.json`

Sensitive credentials the agent's containers may need at runtime. The LLM **never sees the values** — only the key names, which are injected into the system prompt as a reference list.

```json
{
  "OPENAI_API_KEY": "sk-...",
  "DISCORD_BOT_TOKEN": "...",
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
| `beforeInbound` | A user message is received, before LLM sees it | Yes |
| `beforeToolCall` | LLM has chosen a tool, before execution | Yes |
| `afterToolCall` | Tool has returned its result | No |
| `beforeOutbound` | Agent is about to send its final answer | Yes |
| `onHeartbeat` | Heartbeat timer fires | No |
| `onError` | An unhandled error occurs in the loop | No |

"Can block" means the hook handler can throw an error to abort the current operation (e.g., a safety hook blocking a dangerous tool call).

#### Built-in Hook Handlers

| Handler | Hook points | What it does |
|---------|------------|--------------|
| `log` | all | Writes event to episodic memory (this is how all episodic events are recorded) |
| `require-approval` | `beforeToolCall` | Pauses execution and asks user to confirm before proceeding |

#### Custom Hook Handlers — `hooks/hooks.json`

Users can declare custom hooks. Each entry maps a hook point to a list of handlers:

```json
{
  "beforeToolCall": ["require-approval"],
  "afterToolCall": ["log"],
  "onSessionEnd": ["log"]
}
```

In the future, custom handlers can be JS files in `hooks/` that export an async handler function.

#### How hooks integrate with the ReAct loop

```
user message arrives
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
  [onSessionEnd hooks]    ← write session summary to memory
```

---

### 7. Heartbeat Engine

The heartbeat makes the agent **proactive** — it wakes up on a timer and does useful background work without waiting for a user message.

#### How it works

```
Timer fires (e.g., every 1 hour)
      │
  [onHeartbeat hooks]
      │
  Load memory/heartbeat.md
      │
  Run a mini ReAct session with prompt:
  "You are running a scheduled heartbeat. Here is your checklist:
   {heartbeat.md contents}. Check what needs doing and do it."
      │
  Agent executes tools as needed (check containers, update memory, etc.)
      │
  Log heartbeat run to episodic memory
      │
  Agent updates heartbeat.md with timestamps of last run
```

#### `memory/heartbeat.md` — agent-maintained checklist

The agent itself writes and maintains this file. It's a markdown checklist where each task has a cadence and a last-run timestamp. Example:

```markdown
# Heartbeat Checklist

## Hourly
- [ ] Verify all service containers are running — last checked: 2026-03-07 09:00
- [ ] Flush episodic buffer if > 500 events

## Daily
- [ ] Summarise today's episodic log into memory/notes/daily-summary.md — last run: 2026-03-06
- [ ] Clean up ephemeral container records older than 7 days from registry

## Weekly
- [ ] Archive sessions older than 30 days
- [ ] Review memory/notes/ for stale or contradictory facts
```

#### Heartbeat config in `config.json`

```json
"heartbeat": {
  "enabled": true,
  "interval_minutes": 60,
  "max_iterations": 10,
  "tools_allowed": ["read_file", "write_file", "container_status", "memory_note"]
}
```

- `interval_minutes`: how often the heartbeat fires
- `max_iterations`: cap on ReAct loop turns per heartbeat run (keep it short)
- `tools_allowed`: restrict which tools the heartbeat session can use (safety)

#### Key design decisions
- Heartbeat runs in its own isolated mini-session (separate session ID, logged separately)
- It uses the same ReAct loop and tool system as normal sessions
- If a heartbeat run is already in progress when the timer fires again, skip (no overlapping runs)
- Heartbeat does not stream output to any user — results go only to episodic memory

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
| **Tailscale Funnel** | Agent can directly run `tailscale funnel <port>` via the `tailscale_funnel` tool — no sudo needed. Agent tracks which ports are funneled in its config. |
| **Secrets / env vars** | API keys or credentials that containers need. Agent stores these in `config.json` within workspace and injects them as container env vars at launch time. Never written to container images. |
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
  "port_registry": {
    "used": [3000, 5432],
    "funneled": [3000]
  },
  "hooks": {
    "beforeToolCall": ["log"],
    "afterToolCall": ["log"],
    "onSessionStart": ["log"],
    "onSessionEnd": ["log"],
    "onHeartbeat": ["log"]
  },
  "heartbeat": {
    "enabled": true,
    "interval_minutes": 60,
    "max_iterations": 10,
    "autonomy": "readonly",
    "tools_allowed": ["read_file", "write_file", "container_status", "memory_note", "memory_recall"]
  }
}
```

**`~/.cloudmind/{agent-id}/security.json`** — user only, agent cannot write

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_start", "tailscale_funnel"]
}
```

**`~/.cloudmind/{agent-id}/secrets.json`** — user only, agent reads at startup but never logs or passes to LLM

```json
{
  "OPENAI_API_KEY": "sk-...",
  "DISCORD_BOT_TOKEN": "...",
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
| API interface | Local HTTP (Hono) or CLI |
| Deployment | Single host process (systemd or pm2) |
