# System Architecture

## Scope

This document defines the implementation contract for v0.1.

v0.1 is intentionally narrow. It exists to prove one reliable vertical slice:

1. A user sends a task through the CLI
2. The agent reads and writes only inside its workspace
3. The agent can write code or data into `files/`
4. The agent can run that artifact in an ephemeral Docker container
5. The result is returned and logged

In scope for v0.1:

- One host-run agent process
- CLI transport only
- One workspace per agent
- File-based memory and session logs
- Secrets and autonomy policy outside the workspace
- Four tools only: `read_file`, `write_file`, `list_files`, `container_run`
- Ephemeral Docker containers only

Out of scope for v0.1:

- Telegram, Discord, HTTP, WebSocket, or background daemons
- Service containers and host port bindings
- Heartbeat / scheduled runs
- Tailscale Funnel
- Multi-agent orchestration
- Custom hook handlers
- Web UI

Anything outside this list is deferred until after the first end-to-end slice works reliably.

## Core Concept

The agent runs on the host. Docker containers are tools the agent controls.

The agent process is persistent for the lifetime of the CLI session. When it needs to execute code, it launches an ephemeral container, mounts the workspace `files/` directory into that container, captures the result, and removes the container.

The security boundary is the workspace plus typed tools. The agent does not get raw host shell access.

## High-Level Diagram

```text
CLI user
   |
   v
+-------------------------------+
| AgentRunner (host process)    |
|                               |
| - session lifecycle           |
| - context injection           |
| - tool registration           |
| - approval flow               |
+----+---------------+----------+
     |               |
     v               v
+-----------+   +----------------+
| Workspace  |   | ContainerRun   |
| Manager    |   | (Dockerode)    |
+-----+------+   +--------+-------+
      |                   |
      v                   v
 workspace files      ephemeral Docker
 and logs             container
```

## Workspace Layout

Each agent has two roots:

- `~/.cloudmind/{agent-id}/` for autonomy policy and secrets
- `{workspace_root}/` for everything the agent is allowed to read and write

```text
~/.cloudmind/{agent-id}/
|- security.json
`- secrets.json

{workspace_root}/
|- config.json
|- identity/
|  |- IDENTITY.md
|  |- SOUL.md
|  |- USER.md
|  `- AGENTS.md
|- memory/
|  |- working.md
|  |- episodic/
|  |  `- 2026-03.jsonl
|  `- notes/
|- sessions/
|  `- 2026-03-07-s1.jsonl
|- files/
`- logs/
```

Notes:

- `security.json` and `secrets.json` live outside the workspace so the agent cannot modify its own autonomy rules or read secret values through `read_file`.
- `identity/` is user-authored in v0.1. The agent reads it but does not rewrite it.
- `files/` is the only directory mounted into containers in v0.1.
- There is no `containers/registry.jsonl` in v0.1 because service container lifecycle is deferred.

## Runtime Components

### 1. CLI Interface

v0.1 supports only local CLI entry points:

- `cloudmind chat --agent <id>`
- `cloudmind run --agent <id> "..."`

There are no asynchronous transports in v0.1, so approval requests can be handled synchronously in the terminal.

### 2. AgentRunner

CloudMind should wrap `@mariozechner/pi-agent-core` behind a thin `AgentRunner` class.

`AgentRunner` owns:

- session creation and session IDs
- loading `identity/*.md`
- injecting `memory/working.md`
- registering the v0.1 tool set
- translating internal events into session and episodic logs
- interactive approval prompts for protected tools

This wrapper exists so CloudMind does not spread direct `pi-agent-core` assumptions across the codebase.

### 3. Workspace Manager

The workspace manager is the main safety boundary for file access.

Responsibilities:

- scaffold a new workspace
- read and validate `config.json`
- resolve relative paths safely
- perform atomic writes for mutable files

All reads and writes go through the same path validation pipeline:

1. Reject null bytes
2. Resolve against `workspace_root`
3. Reject paths that escape the workspace root
4. On reads, compare the target `realpath` against the workspace root
5. On writes to new files, compare the nearest existing parent directory `realpath` against the workspace root

That fifth rule is required because `realpathSync` on a new file path will fail if the file does not exist yet.

### 4. Memory Manager

v0.1 keeps memory simple and file-based:

- `memory/working.md`: short rolling context
- `memory/notes/*.md`: durable user or project notes
- `memory/episodic/{YYYY-MM}.jsonl`: append-only event log
- `sessions/{date}-{id}.jsonl`: append-only session transcript

Requirements:

- writes to `working.md` and notes are atomic
- JSONL appends are serialized through a single writer queue or lock
- old monthly episodic files are read-only archives

### 5. Ephemeral Container Runner

v0.1 implements one execution primitive: `container_run`.

Behavior:

- create an ephemeral container
- mount `{workspace_root}/files` at `/workspace`
- run a command
- capture `stdout`, `stderr`, exit code, and duration
- remove the container after completion

Safety defaults:

- CPU and memory limits are always set
- execution timeout is always set
- network is disabled by default
- images must match an allowlist from `config.json`

If network access is needed later, it should be an explicit opt-in design change, not an accidental default.

## Tool Surface

Only these tools exist in v0.1.

### `read_file(path)`

- Reads a file within the workspace
- Intended for `files/`, `memory/`, and `identity/`
- Never reads `~/.cloudmind/{agent-id}/`

### `write_file(path, content)`

- Writes only inside these writable roots:
  - `files/`
  - `memory/working.md`
  - `memory/notes/`
- Cannot modify `config.json`
- Cannot modify `identity/`

### `list_files(dir)`

- Lists workspace files under an allowed directory
- Used to inspect `files/`, `memory/notes/`, or similar workspace subtrees

### `container_run({ image, command, workdir?, env_secrets? })`

- Runs an ephemeral container
- Mounts `files/` to `/workspace`
- `workdir` is relative to `/workspace`
- `env_secrets` contains secret names only
- Secret values are resolved by the host process and injected into the container at runtime

There is no `container_start`, `container_stop`, `container_exec`, `web_fetch`, `tailscale_funnel`, or `agent_doctor` in v0.1.

## Security Model

### Autonomy Policy

Autonomy policy is stored at `~/.cloudmind/{agent-id}/security.json`.

v0.1 keeps the existing three-level model:

- `readonly`
- `supervised`
- `full`

Default for v0.1 is `supervised`.

Because v0.1 is CLI-only, `require_approval_for` can block synchronously in the terminal. There is no background approval queue in this milestone.

Suggested default:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_run"]
}
```

### Secrets

Secrets are stored at `~/.cloudmind/{agent-id}/secrets.json`, outside the workspace.

The LLM never sees secret values. It only sees secret names, for example:

```text
Available secrets: OPENAI_API_KEY, GITHUB_TOKEN
```

Credential flow:

```text
secrets.json -> agent process memory -> Docker env var -> container process
```

Secret values never appear in:

- `read_file` output
- tool results returned to the LLM
- session logs
- episodic logs

### Container Safety

Containers are still a risk surface even if they do not touch the host filesystem.

For v0.1, the minimum policy should be:

- image allowlist
- resource limits
- timeout
- network disabled by default
- explicit logging of image, command, duration, and exit code

That is a better safety baseline than relying on command whitelists.

## Persistence and Logging

`config.json` is read by the runtime but not modified by the agent through tool calls in v0.1.

Example `config.json`:

```json
{
  "agent_id": "agent-abc123",
  "name": "My Agent",
  "created": "2026-03-07T00:00:00Z",
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "max_tokens": 8192
  },
  "identity": {
    "files": [
      "identity/IDENTITY.md",
      "identity/SOUL.md",
      "identity/USER.md",
      "identity/AGENTS.md"
    ]
  },
  "container_defaults": {
    "image_allowlist": ["python:3.12-slim", "node:22-slim"],
    "memory_limit": "512m",
    "cpu_shares": 512,
    "timeout_seconds": 120,
    "network": "disabled"
  }
}
```

Example session log line format:

```jsonl
{"ts":"2026-03-07T10:00:05Z","role":"user","content":"Write a fibonacci script"}
{"ts":"2026-03-07T10:00:08Z","role":"tool_call","name":"write_file","args":{"path":"files/fib.py"}}
{"ts":"2026-03-07T10:00:14Z","role":"tool_result","name":"container_run","content":{"exitCode":0}}
```

Example episodic log line format:

```jsonl
{"ts":"2026-03-07T10:00:00Z","session":"s1","type":"session_started","data":{}}
{"ts":"2026-03-07T10:00:14Z","session":"s1","type":"tool_result","data":{"tool":"container_run","exitCode":0}}
{"ts":"2026-03-07T10:00:15Z","session":"s1","type":"session_ended","data":{"turns":2}}
```

## Deferred After v0.1

These are valid future directions, but they are intentionally not part of the initial contract:

- service containers
- host port allocation
- Docker networks
- heartbeat sessions
- custom hook handlers
- model switching at runtime
- Telegram or other IM transports
- web UI
- multi-agent registry and lifecycle management
- Tailscale Funnel integration

Those features should be added only after the single-agent CLI path is stable.

## Tech Stack

| Component | Technology |
|-----------|------------|
| Agent runtime | Node.js + TypeScript |
| Agent loop wrapper | `AgentRunner` |
| LLM abstraction | `@mariozechner/pi-ai` |
| Tool loop | `@mariozechner/pi-agent-core` |
| Container management | Dockerode |
| Persistence | Markdown + JSONL + JSON |
