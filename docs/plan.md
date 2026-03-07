# Development Plan

## Objective

Ship a narrow v0.1 that proves one complete loop:

1. start an agent from the CLI
2. give it a task
3. let it write files inside its workspace
4. let it run those files inside an ephemeral Docker container
5. return the result
6. persist the session and episodic logs

If that path is not solid, the rest of the roadmap is premature.

## Success Criteria

v0.1 is done when all of the following are true:

- `cloudmind run --agent <id> "write a script and run it"` works end to end
- all file access stays inside the workspace
- secrets are loaded from `~/.cloudmind/{agent-id}/secrets.json`
- `container_run` uses an ephemeral container with limits and timeout
- session and episodic logs are written without corruption

## Non-Goals

Not part of v0.1:

- background daemons
- Telegram or any IM bridge
- service containers
- host port management
- heartbeat runs
- custom hooks
- multi-agent registry
- Tailscale Funnel
- Web UI

## Phase 1 - Workspace and Safety Boundary

Goal: create the workspace layout and make path handling correct before any agent loop or Docker execution exists.

### 1.1 Workspace scaffolding

- [ ] Define the workspace layout from `docs/architecture.md`
- [ ] `workspace.init(agentId, workspaceRoot)` creates:
  - `config.json`
  - `identity/`
  - `memory/working.md`
  - `memory/notes/`
  - `memory/episodic/`
  - `sessions/`
  - `files/`
  - `logs/`
- [ ] `security.init(agentId)` creates `~/.cloudmind/{agent-id}/security.json`
- [ ] `secrets.init(agentId)` creates `~/.cloudmind/{agent-id}/secrets.json`

### 1.2 Path validation

- [ ] `workspace.resolveRead(path)`:
  - reject null bytes
  - resolve against workspace root
  - reject escapes
  - compare target `realpath` against workspace root
- [ ] `workspace.resolveWrite(path)`:
  - reject null bytes
  - resolve against workspace root
  - reject escapes
  - validate the nearest existing parent directory with `realpath`
- [ ] Restrict writable roots to:
  - `files/`
  - `memory/working.md`
  - `memory/notes/`

### 1.3 Config and secrets loading

- [ ] typed loader for `{workspace}/config.json`
- [ ] typed loader for `~/.cloudmind/{agent-id}/security.json`
- [ ] typed loader for `~/.cloudmind/{agent-id}/secrets.json`
- [ ] `secrets.listNames()` returns names only
- [ ] `secrets.resolve(names)` returns values only to host-side tool handlers

### 1.4 File I/O behavior

- [ ] atomic write helper for mutable markdown and JSON files
- [ ] append helper for JSONL logs
- [ ] writer lock or queue for concurrent log appends

### 1.5 Tests

- [ ] `../` traversal is rejected
- [ ] symlink escape is rejected
- [ ] null byte paths are rejected
- [ ] writes outside allowed roots are rejected
- [ ] secret values never appear in returned tool results

Deliverable: create a workspace, read and write allowed files, and prove path escapes fail.

## Phase 2 - Ephemeral Container Runner

Goal: run code inside Docker without introducing service lifecycle complexity.

### 2.1 Container runner

- [ ] wrap Dockerode behind `container.runEphemeral()`
- [ ] mount `{workspace}/files` to `/workspace`
- [ ] capture `stdout`, `stderr`, exit code, and duration
- [ ] remove the container after completion

### 2.2 Safety defaults

- [ ] enforce image allowlist from `config.json`
- [ ] enforce CPU and memory limits
- [ ] enforce timeout
- [ ] disable network by default
- [ ] log image, command, duration, and exit code

### 2.3 Integration tests

- [ ] run `python:3.12-slim` and print `"hello"`
- [ ] write `files/input.txt`, run a container that reads it, and assert output
- [ ] reject a disallowed image
- [ ] verify timeout kills a long-running command

Deliverable: a test script proves CloudMind can safely run an artifact from `files/` inside an ephemeral container.

## Phase 3 - Agent Runtime and Tool Loop

Goal: connect the workspace and container runner to a real agent loop.

### 3.1 AgentRunner wrapper

- [ ] install `@mariozechner/pi-ai`
- [ ] install `@mariozechner/pi-agent-core`
- [ ] implement `AgentRunner` as the only place that talks to `pi-agent-core`
- [ ] create session IDs and session lifecycle events inside `AgentRunner`

### 3.2 Context assembly

- [ ] load `identity/IDENTITY.md`, `SOUL.md`, `USER.md`, and `AGENTS.md`
- [ ] inject `memory/working.md`
- [ ] expose available secret names only
- [ ] keep the context assembly logic outside tool handlers

### 3.3 v0.1 tools

- [ ] `read_file`
- [ ] `write_file`
- [ ] `list_files`
- [ ] `container_run`

### 3.4 Logging

- [ ] write a session log line for every user message, assistant message, tool call, and tool result
- [ ] write an episodic event for session start, tool execution, and session end
- [ ] ensure secret values are redacted before any logging

### 3.5 CLI

- [ ] `cloudmind chat --agent <id>`
- [ ] `cloudmind run --agent <id> "<task>"`
- [ ] synchronous approval prompt for tools in `require_approval_for`

Deliverable: "Write a Python script that prints the first 20 Fibonacci numbers, run it, and show me the output." works from the CLI end to end.

## Phase 4 - Hardening

Goal: make the first slice robust enough to build on.

### 4.1 Reliability

- [ ] graceful handling for invalid config, missing secrets, Docker unavailable, and tool failures
- [ ] clear error messages when approvals are denied
- [ ] log rotation or daily log files under `logs/`

### 4.2 Tests

- [ ] CLI single-shot integration test
- [ ] approval flow test
- [ ] concurrent log append test
- [ ] regression tests for path validation and secret redaction

### 4.3 Minimal operator tooling

- [ ] `cloudmind doctor --agent <id>`:
  - config is readable
  - security file is readable
  - secrets file is readable
  - Docker is reachable
  - workspace directories exist

Deliverable: v0.1 is shippable for one local user on one machine.

## Deferred After v0.1

These can return only after the v0.1 path is stable:

- service containers and container registry
- port allocation and Docker networks
- background process management
- heartbeat sessions
- Telegram, Discord, HTTP, and WebSocket transports
- custom hook handlers
- runtime model switching
- multi-agent lifecycle and registry
- Tailscale Funnel integration
- Web UI

## File Format Reference

### `{workspace}/config.json`

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

### `~/.cloudmind/{agent-id}/security.json`

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_run"]
}
```

### `memory/episodic/2026-03.jsonl`

```jsonl
{"ts":"2026-03-07T10:00:00Z","session":"s1","type":"session_started","data":{}}
{"ts":"2026-03-07T10:00:08Z","session":"s1","type":"tool_called","data":{"tool":"write_file","path":"files/fib.py"}}
{"ts":"2026-03-07T10:00:14Z","session":"s1","type":"tool_result","data":{"tool":"container_run","exitCode":0}}
{"ts":"2026-03-07T10:00:15Z","session":"s1","type":"session_ended","data":{"turns":2}}
```

### `sessions/{date}-{id}.jsonl`

```jsonl
{"ts":"2026-03-07T10:00:05Z","role":"user","content":"Write a fibonacci script"}
{"ts":"2026-03-07T10:00:08Z","role":"tool_call","name":"write_file","args":{"path":"files/fib.py"}}
{"ts":"2026-03-07T10:00:14Z","role":"tool_result","name":"container_run","content":{"stdout":"1 1 2 3 5","exitCode":0}}
{"ts":"2026-03-07T10:00:15Z","role":"assistant","content":"Here are the first 20 Fibonacci numbers."}
```
