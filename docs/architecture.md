# OpenHermit Architecture

This document describes the current target architecture for OpenHermit.

OpenHermit is a host-based autonomous agent platform:

- the agent runtime runs on the host
- containers are sandboxed tools and services, not the agent itself
- external task files live in a workspace
- internal runtime state lives outside the workspace

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
- episodic checkpoints
- session-local working memory
- global working memory
- long-term system memory
- approvals
- bindings
- schedules and schedule runs
- container runtime inventory
- runtime discovery metadata

Internal state is not part of the agent's ordinary task workspace.

## Storage Layout

### Workspace

The workspace is the agent's external sandbox.

Typical structure:

```text
workspace/
├── config.json
├── identity/
│   ├── IDENTITY.md
│   ├── SOUL.md
│   ├── USER.md
│   └── AGENTS.md
├── files/
├── containers/
│   ├── registry.jsonl
│   └── {container-name}/
│       └── data/
├── hooks/
│   └── hooks.json
└── logs/
```

Notes:

- `identity/` currently remains workspace-authored input
- `files/` is the main area the agent reads, writes, and searches
- `containers/{name}/data/` is external state because it contains mounted task data
- the workspace no longer defaults to storing session, memory, or runtime discovery state

### Per-Agent Internal State

Internal state lives under:

```text
~/.openhermit/{agent-id}/
├── security.json
├── secrets.json
├── runtime.json
└── state.sqlite
```

Current responsibilities:

- `security.json`: autonomy and approval policy
- `secrets.json`: provider and integration secrets
- `runtime.json`: local discovery metadata for the agent-local API
- `state.sqlite`: sessions, messages, episodic checkpoints, and other runtime-owned records

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
- memory updates
- HTTP + SSE transport

## Session Model

Sessions are durable threads identified by `sessionId`.

Important rules:

- the agent core only knows `sessionId`
- sessions do not have a permanent `closed` state
- any old session can be resumed later
- adapter binding decides which session a user is currently talking to

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

Containers are split into two categories:

- `ephemeral`
- `service`

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

OpenHermit uses four logical memory layers:

- session log
- episodic memory
- working memory
- long-term memory

Current direction:

- raw session history, episodic checkpoints, and memories live in `state.sqlite`
- system-managed long-term memory should also live in `state.sqlite`
- user-authored knowledge should remain external and searchable as normal files
- every completed user-visible turn should be followed by a program-triggered self-introspection turn
- long-term memory should be updated through idle consolidation and explicit user instruction

See:

- [memory-model.md](memory-model.md)
- [session-model.md](session-model.md)

## Scheduling Direction

Scheduling should be program-level orchestration, not heartbeat-specific behavior inside the agent runtime.

The direction is:

- scheduler triggers runs
- agent executes runs as ordinary sessions/messages
- heartbeat becomes one task handler, not the scheduling model

## Future Gateway

A future gateway/control plane may add:

- multi-agent lifecycle management
- unified `/agents/{id}/...` APIs
- schedule management
- channel orchestration
- monitoring

That gateway should sit above per-agent runtimes, not replace the agent-local contract.
