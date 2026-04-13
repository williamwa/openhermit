# OpenHermit Architecture

This document describes the current target architecture for OpenHermit.

OpenHermit is a container-native autonomous agent platform:

- the agent runtime orchestrates execution across containers
- all agent work (code execution, file operations, services) runs inside Docker containers
- external task files live in a workspace
- internal runtime state lives outside the workspace

## Project Goals

OpenHermit is intentionally shaped around a few problems that show up in OpenClaw-style systems:

- **security through sandboxed execution**
  OpenHermit treats isolated execution as a first-class requirement. All agent work runs inside containers — the workspace container for everyday execution, service containers for daemons, and ephemeral containers for one-off tasks.

- **multi-user and multi-agent readiness**
  OpenHermit is not only for one self-hosting operator. The architecture is being built so that multiple agents, multiple users, future scheduling, and future gateway-style deployment remain natural extensions instead of afterthoughts.

- **clear component boundaries**
  OpenHermit avoids collapsing runtime, client, gateway, and protocol concerns into one large package. Components should stay separate and communicate through explicit APIs and contracts.

## Core Boundary

OpenHermit separates state into two categories:

- `external state`
- `internal state`

### External State

External state is the world the agent works on for the user.

Examples:

- project files
- generated artifacts
- user-authored docs and prompts
- container-mounted working data
- sandbox files under the agent workspace

This is the real task workspace.

### Internal State

Internal state is owned by the OpenHermit program and runtime.

Examples:

- session metadata
- session messages and events
- session-local working memory
- long-term memories (via MemoryProvider)
- instructions
- container runtime inventory
- runtime discovery metadata

Internal state is not part of the agent's ordinary task workspace.

Agent-facing memory tools provide CRUD + search over the MemoryProvider: `memory_add`, `memory_get`, `memory_recall`, `memory_update`, `memory_delete`.
Agent-facing instruction tools manage persistent instructions: `instruction_read`, `instruction_update`.
Episodic and working memory remain runtime-managed internal state.

## Storage Layout

### Workspace

The workspace is the agent's external sandbox.

Typical structure:

```text
workspace/
├── .openhermit/
│   ├── config.json
│   ├── IDENTITY.md
│   ├── SOUL.md
│   └── AGENTS.md
└── containers/
│   └── {container-name}/
│       └── data/
```

Notes:

- the default scaffold is intentionally minimal: `.openhermit/` and `containers/`
- `workspace/.openhermit/config.json` is the workspace-owned external config surface for agent-manageable integrations and channels
- `workspace/.openhermit/*.md` (IDENTITY.md, SOUL.md, AGENTS.md) serve as bootstrap sources for identity
- on first boot, these files are migrated into the `InstructionStore` in `state.sqlite`
- after migration, the `InstructionStore` is the canonical source; the agent manages instructions via `instruction_read` and `instruction_update` tools
- additional directories such as `files/` may be created later by user work or agent actions
- `containers/{name}/data/` is external state because it contains mounted task data
- container runtime inventory is internal state and now lives in `state.sqlite`
- the workspace no longer defaults to storing session, memory, or runtime discovery state

### Per-Agent Internal State

Internal state lives under:

```text
~/.openhermit/{agent-id}/
├── config.json
├── security.json
├── secrets.json
├── runtime.json   # only while the agent is running
└── state.sqlite
```

Current responsibilities:

- `config.json`: runtime-owned configuration such as model selection, identity file list, introspection settings, and preferred local API port
- `security.json`: autonomy and approval policy
- `secrets.json`: provider and integration secrets
- `runtime.json`: live local discovery metadata for the agent-local API
- `state.sqlite`: sessions, messages, memories, container runtime inventory, and other runtime-owned records managed through lightweight versioned migrations

## Runtime Discovery

Every running agent writes:

- `~/.openhermit/{agent-id}/runtime.json`

Current shape:

```json
{
  "http_api": {
    "port": 3001,
    "token": "..."
  },
  "updated_at": "2026-03-13T00:00:00.000Z"
}
```

This file is used by:

- CLI
- local web launcher
- future bridges and adapters

Lifecycle rules:

- it exists only while the agent is actively running
- normal shutdown removes it
- startup refuses to overwrite an existing file and instead reports whether another agent is still responding or the file looks stale

## Agent Runtime

The per-agent runtime is responsible for:

- model loop
- tool calling
- session execution
- approval pauses
- SSE event streaming

It is not responsible for:

- owning the external workspace as a source of internal truth
- embedding scheduling policy inside heartbeat-specific logic
- acting as a multi-agent gateway

## LLM Stack

OpenHermit uses:

- `@mariozechner/pi-ai`
- `@mariozechner/pi-agent-core`

OpenHermit provides the surrounding runtime:

- workspace access
- built-in tools
- approval orchestration
- session persistence
- memory updates via pluggable MemoryProvider
- future compaction for long-running sessions
- optional Langfuse tracing around model requests when `apps/agent/.env` provides `LANGFUSE_*`
- HTTP + SSE transport

## Session Model

Sessions are durable threads identified by `sessionId`.

Important rules:

- the agent core only knows `sessionId`
- sessions do not have a permanent `closed` state
- any old session can be resumed later
- adapter binding decides which session a user is currently talking to
- long-running sessions use compaction for context limits and introspection for memory maintenance

Current execution states:

- `idle`
- `running`
- `awaiting_approval`

## HTTP API

Agent-local routes:

```text
POST /sessions
GET /sessions
GET /sessions/{sessionId}/messages
POST /sessions/{sessionId}/messages
POST /sessions/{sessionId}/approve
POST /sessions/{sessionId}/checkpoint
GET /sessions/{sessionId}/events
```

Notes:

- each agent runs on its own local port
- callers discover that port via `runtime.json`
- route paths do not repeat `{agentId}`
- the API is agent-local, not a multi-agent gateway

## Containers

Containers are split into three categories:

- `ephemeral` — one-shot execution, auto-removed
- `service` — long-running daemons (databases, web servers)
- `workspace` — persistent container with workspace mounted at `/workspace`, used for `exec`

## Introspection vs. Compaction

OpenHermit treats introspection and compaction as separate runtime mechanisms.

### Introspection

Introspection exists to update memory:

- long-term memory (via memory tools)
- session-local working memory
- session description

Introspection is a lightweight agent turn triggered by the runtime with memory-only tools.
The periodic turn interval counts completed agent runs, not intermediate assistant messages inside one run.

### Compaction

Compaction exists to keep long-running sessions inside model context limits.

It should:

- summarize or compress older conversational state
- preserve recent turns needed for immediate continuity
- reduce prompt size before retrying a user-visible turn

Current first pass:

- applies before model calls when the runtime estimates the prompt is over budget
- rewrites older history into one runtime-generated compact summary block
- preserves recent raw turns verbatim

Compaction should not be treated as a replacement for memory updates. Its primary purpose is runtime context hygiene, not durable memory generation.

### Ephemeral Containers

- one-shot execution
- no long-lived ports
- auto-removed

### Service Containers

- long-running
- port-bound
- explicitly stopped
- tracked in runtime inventory

Boundary:

- container runtime object = internal state
- mounted container data = external state

## Memory

OpenHermit uses two logical memory layers:

- working memory — session-local active state
- long-term memory — durable knowledge via MemoryProvider

Current direction:

- raw session history and memories live in `state.sqlite`
- long-term memories are managed through a pluggable `MemoryProvider` interface (default: `SqliteMemoryProvider`)
- the MemoryProvider exposes `getContextBlock()` to inject relevant memory into each turn's context
- user-authored knowledge should remain external and searchable as normal files
- memory is maintained by periodic introspection turns (lightweight agent with memory tools)
- durable memory is also updated through explicit user instruction ("remember this")

See:

- [memory-model.md](memory-model.md)
- [session-model.md](session-model.md)

## Scheduling Direction

Scheduling should be program-level orchestration, not heartbeat-specific behavior inside the agent runtime.

The direction is:

- scheduler triggers runs
- agent executes runs as ordinary sessions/messages
- heartbeat becomes one task handler, not the scheduling model

## Gateway

The gateway (`apps/gateway/`) is a control plane that sits above per-agent runtimes:

- multi-agent lifecycle management (start, stop, restart)
- agent registry and health checks
- proxy routing: `/agents/{id}/...` → agent-local API
- unified agent listing API

Planned additions:

- schedule management
- channel orchestration
- monitoring

The gateway proxies requests to per-agent processes and does not replace the agent-local contract.
