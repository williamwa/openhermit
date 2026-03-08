# Development Plan

## Phases Overview

```
Phase 1 — Workspace + Container Primitives
Phase 2 — Agent Core (LLM loop + tools + hook system)
Phase 3 — Memory System (file-based)
Phase 4 — Agent Lifecycle + Config
Phase 5 — Service Containers + Telegram Trigger Adapter
Phase 6 — Scheduled Sessions (Heartbeat + Cron)
Phase 7 — Polish (CLI, multi-agent, SQLite upgrade)
```

---

## Phase 1 — Workspace + Container Primitives

**Goal**: Define the workspace layout and prove that the agent can spin up, use, and tear down Docker containers — mounting files from the workspace.

### 1.1 Workspace Module
- [ ] Define workspace directory structure (as per architecture)
- [ ] `workspace.init(path)` — scaffold a new agent workspace with empty dirs, default config.json, and identity/ files
- [ ] `workspace.readConfig()` / `workspace.writeConfig()` — typed config read/write
- [ ] `workspace.resolve(relativePath)` — safe path resolver with three-layer validation:
  - Layer 1: null byte check (`path.includes('\0')` → throw)
  - Layer 2: workspace boundary check (`resolved = path.resolve(root, candidate)`; `relative = path.relative(root, resolved)`; throw if `relative` is absolute or starts with `..`)
  - Layer 3: symlink escape check (`realpath` the target if it exists, otherwise `realpath` the nearest existing ancestor before create/write; throw if canonical path escapes workspace)
- [ ] Tests: path escape via `../`, sibling-prefix roots (workspace vs workspace-evil), symlinks, and null bytes all throw

### 1.2 Security + Secrets Module
- [ ] Load `~/.cloudmind/{agent-id}/security.json` at startup (read-only, never write from agent)
- [ ] Load `~/.cloudmind/{agent-id}/secrets.json` at startup into memory (read-only, never logged, never passed to LLM)
- [ ] `security.checkPath(path)` — runs three-layer validation (null byte → workspace boundary → symlink escape); no configurable forbidden-paths list needed — the workspace boundary covers it architecturally
- [ ] `security.getAutonomyLevel()` — returns current level: `readonly | supervised | full`
- [ ] `security.requiresApproval(toolName)` — checks `require_approval_for` list from security config
- [ ] `secrets.resolve(names: string[])` — returns `Record<string, string>` of name → value for use as Docker env vars; throws if any name is not found
- [ ] `secrets.listNames()` — returns key names only (no values), used to inject into system prompt
- [ ] `security.init()` — scaffolds `~/.cloudmind/{agent-id}/` directory with default `security.json` and empty `secrets.json` if not exists
- [ ] Tests: path escape via `../`, sibling-prefix roots, symlinks, and null bytes all throw; autonomy level correctly loaded; approval list works; secret values never appear in any return value to LLM layer

### 1.3 Container Manager Module
- [ ] Wrap Dockerode with typed interface
- [ ] `container.runEphemeral({ image, command, description?, mount?, env? })` — run and return output, auto-remove
  - Mount: `workspace/containers/{name}/data/` → `/workspace` in container
  - Parse sentinel markers (`---CLOUDMIND_OUTPUT_START---` / `---CLOUDMIND_OUTPUT_END---`) from stdout
  - Return: `{ stdout, stderr, exitCode, durationMs, parsedOutput? }`
  - Persist `description` into `containers/registry.jsonl` so the purpose of the run remains visible after removal
  - Validate mount path through `security.checkPath()` before passing to Docker
- [ ] `container.startService({ image, name, description?, mount?, ports?, env? })` — start long-running container
- [ ] Registry schema includes `description` — a short human/agent-written note describing why the container exists
- [ ] `container.stopService(name)` — stop + remove service container
- [ ] `container.execInService(name, command)` — exec command in running container
- [ ] `container.listAll()` — return all containers from registry.jsonl + live Docker status, including persisted `description`
- [ ] Write to `containers/registry.jsonl` on every create/stop/remove, preserving `description`

### 1.4 Integration test
- [ ] Init workspace → run `python:3.12` ephemeral container → execute `print("hello")` → assert output
- [ ] Init workspace → write file to `containers/test/data/input.txt` → run container that reads it → assert output
- [ ] Init workspace → create a file → delete it via `delete_file` → assert it no longer exists
- [ ] Start postgres service container with a description → verify it appears in registry → stop it → verify removed entry still retains description metadata

**Deliverable**: A test script that proves workspace isolation and container lifecycle work end-to-end.

---

## Phase 2 — Agent Core (pi-ai + pi-agent-core + Tools)

**Goal**: A running agent that receives a message, thinks, calls tools, executes them, and returns an answer — built on `@mariozechner/pi-ai` (multi-provider LLM abstraction) and `@mariozechner/pi-agent-core` (stateful tool-calling loop), not a custom ReAct implementation.

### 2.1 Integrate pi-ai + pi-agent-core
- [ ] `npm install @mariozechner/pi-ai @mariozechner/pi-agent-core`
- [ ] Define `config.model` as a structured provider/model object, e.g. `{ "provider": "anthropic", "model": "claude-sonnet-4-5", "max_tokens": 8192 }`
- [ ] Provider API keys (for pi-ai) read from `~/.cloudmind/{agent-id}/secrets.json` at startup — same secrets store, same loading path as other credentials
- [ ] `transformContext` callback: fires before every LLM call, injects fresh context:
  - Load `identity/IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md` into system prompt
  - Load `memory/working.md` as first user-side context block
  - Inject note filenames so agent knows what topics it has stored
- [ ] Event → hook wiring (pi-agent-core events mapped to CloudMind lifecycle hooks):
  - `agent_start` → `onSessionStart`
  - `tool_execution_start` → `beforeToolCall`
  - `tool_execution_end` → `afterToolCall`
  - `agent_end` → `onSessionEnd`
  - `error` → `onError`
- [ ] Model switching helper: `agent.setModel(getModel(provider, model))` exposed as `cloudmind model set <agent-id> <provider> <model> [--max-tokens N]`
- [ ] `cloudmind models` command — lists all pi-ai supported models + current selection
- [ ] Cost tracking: accumulate pi-ai `usage` events per session; write summary to episodic log at session end

### 2.2 Tool Definitions (TypeBox / AgentTool format)
- [ ] Define all tools as `AgentTool` objects (TypeBox schema + handler), registered with pi-agent-core
- [ ] All tools check `security.getAutonomyLevel()` — `readonly` mode blocks write/delete/exec tools immediately
- [ ] Built-in tools wired up to workspace + container modules:
  - `read_file(path)` — reads file from workspace (path through `security.checkPath()`)
  - `write_file(path, content)` — writes file to workspace (path through `security.checkPath()`)
  - `list_files(dir)` — lists workspace directory
  - `delete_file(path)` — deletes one file from workspace (path through `security.checkPath()`); explicit delete semantics, not emulated via `write_file`
  - `container_run(image, command, description?, mount?, env_secrets?, workdir?)` — ephemeral container run; `description` is persisted to the registry as the purpose of the run; `mount` must be a validated workspace path under `containers/{name}/data/`; `env_secrets` names resolved via `secrets.resolve()` and injected as Docker env vars
  - `container_start(name, image, description?, mount?, ports?, env?, env_secrets?)` — start service container; `description` is persisted to the registry as the purpose of the service; `mount` must be a validated workspace path under `containers/{name}/data/`; `env_secrets` names resolved at launch, values never returned to LLM
  - `container_stop(name)` — stop service container
  - `container_exec(name, command)` — exec in running container
  - `container_status()` — list containers + status + description
  - `web_fetch(url)` — HTTP GET, return body as text
  - `agent_doctor()` — self-diagnostics (see Phase 4)
- [ ] `delete_file` counts as a destructive write tool; support placing it in `require_approval_for`

### 2.3 Hook System
- [ ] Define hook point enum: `onSessionStart | onSessionEnd | beforeInbound | beforeToolCall | afterToolCall | beforeOutbound | onScheduleTrigger | onError`
- [ ] Hook registry: map each hook point → ordered list of async handler functions
- [ ] Hook runner: `runHooks(point, context)` — execute handlers in order; blocking hook points abort the current operation if a handler throws, non-blocking hook points log the failure to `onError` and continue
- [ ] Built-in handler: `log` — appends event to episodic memory (replaces all manual episodic writes)
- [ ] Built-in handler: `require-approval` — pauses `beforeToolCall`, prints tool name + args to user, waits for y/n confirmation
- [ ] Wire hooks to pi-agent-core events at all defined hook points
- [ ] Load hook config from `config.json` at agent startup
- [ ] Custom hooks: load user-defined handler files from `hooks/` directory (later, skip for now)

### 2.4 Session Lifecycle Interface + HTTP API + CLI Client
- [ ] Define `SessionSpec` type: `{ sessionId, source, metadata? }`
- [ ] Define `SessionMessage` type: `{ messageId?, text, attachments? }`
- [ ] `source.kind` captures the semantic trigger class: `cli | im | heartbeat | cron | ...`
- [ ] `source.platform` captures adapter-specific detail when needed, e.g. `telegram | discord | feishu`
- [ ] `source.interactive` determines whether the caller subscribes to SSE or the run is treated as a non-interactive scheduled session
- [ ] `POST /sessions` is metadata-only: it creates or resumes session state, but the runner should not advance until the first `SessionMessage` is posted
- [ ] Define `OutboundEvent` SSE types: `text_delta | text_final | tool_start | error`
- [ ] Expose `AgentRunner.openSession(spec)` and `AgentRunner.postMessage(sessionId, message)` inside the agent process; all adapters call this lifecycle interface
- [ ] Implement Hono HTTP adapter inside the agent process:
  - `POST /sessions` — validates bearer token, accepts `SessionSpec`, creates or resumes the session, returns `{ sessionId }`
  - `POST /sessions/{sessionId}/messages` — validates bearer token, accepts `SessionMessage`, appends one inbound message, returns `{ sessionId, messageId? }`
  - `GET /events?sessionId=xxx` — SSE stream, pushes `OutboundEvent`s as the agent processes the session
- [ ] Runtime API token: generate on startup, write to `runtime/api.token` (create `runtime/` dir, add to `.gitignore`)
- [ ] Dynamic port binding: try `config.http_api.preferred_port` first; if taken, bind to port `0` (OS assigns free port); write actual port to `runtime/api.port` — guarantees zero conflicts when multiple agents run on the same host
- [ ] Treat the HTTP API as agent-local: clients first choose the target agent by reading its workspace/runtime metadata, then talk to that agent's local port directly; route paths do not repeat `{agentId}`
- [ ] CLI client (`cloudmind chat --agent <id>`): reads `runtime/api.port` and `runtime/api.token`, creates or resumes a `source.kind = "cli"` session, subscribes to SSE, then posts the first and subsequent user messages to `/sessions/{sessionId}/messages`
- [ ] `cloudmind run --agent <id> "task"` — same as above but single-shot (no readline loop)
- [ ] Scheduled triggers in Phase 6 reuse the same `SessionSpec + SessionMessage` lifecycle in-process or over HTTP; no second execution path
- [ ] `cloudmind models` — list all available models across providers
- [ ] `cloudmind model set <agent-id> <provider> <model> [--max-tokens N]` — switch model at runtime via `agent.setModel()`
- [ ] `cloudmind model get <agent-id>` — show current model

**Deliverable**: "Write a Python script that generates the first 20 Fibonacci numbers, run it, and show me the output." → agent writes file into an ephemeral run mount → spawns container → runs script → hooks fire → result streams to terminal via SSE. Run the same task with a different configured model (for example `openai gpt-4o`) to verify multi-provider works.

---

## Phase 3 — Memory System

**Goal**: Agent reads/writes memory files correctly, context stays coherent across tool calls and sessions.

### 3.1 Working Memory
- [ ] Load `memory/working.md` at session start → inject into system prompt
- [ ] `memory_update_working(content)` tool — agent rewrites working.md
- [ ] Auto-prompt agent to update working memory at session end if context changed significantly
- [ ] Keep working.md under a token limit (warn agent if it's growing too large)

### 3.2 Episodic Memory
- [ ] Write to `memory/episodic/{YYYY-MM}.jsonl` — auto-create new file each month
- [ ] All writes go through the `log` hook handler (no direct episodic writes elsewhere)
- [ ] Event schema: `{ ts, session, type, data }`
- [ ] `episodic_read(limit?, since?)` tool — agent can query recent events (reads across monthly files as needed)

### 3.3 Long-term Notes
- [ ] `memory_note(topic, content)` tool — write/overwrite `memory/notes/{topic}.md`
- [ ] `memory_recall(topic)` tool — read a note file back
- [ ] `memory_list_notes()` tool — list available topics
- [ ] Inject note filenames (not content) into system prompt so agent knows what it has

### 3.4 Session Log
- [ ] Auto-create `sessions/{date}-{id}.jsonl` at session start
- [ ] Append every message + tool call/result during session
- [ ] Session summary: at end of session, optionally prompt agent to write a summary note

**Deliverable**: Agent remembers a user's name and preferred programming language across two separate sessions without being told again.

---

## Phase 4 — Agent Lifecycle + Config

**Goal**: Multiple named agents, clean start/stop, persistent state across process restarts.

### 4.1 Agent Registry
- [ ] Global registry at `~/cloudmind/agents.jsonl` — list of all agents + workspace paths
- [ ] `cloudmind agent create --name "My Agent"` — scaffold workspace + register
- [ ] `cloudmind agent list` — show all agents + status
- [ ] `cloudmind agent delete <id>` — remove workspace + registry entry

### 4.2 Process Management
- [ ] `cloudmind start <agent-id>` — start agent as background process (pm2 or simple fork)
- [ ] `cloudmind stop <agent-id>` — graceful shutdown
- [ ] On startup: reconcile container registry with live Docker state (mark dead containers as removed)
- [ ] On shutdown: leave service containers running unless they were explicitly stopped, and record shutdown in episodic log

### 4.3 Config Management
- [ ] `cloudmind config set <agent-id> <key> <value>` — update config.json
- [ ] `cloudmind security edit <agent-id>` — open `~/.cloudmind/{id}/security.json` in $EDITOR
- [ ] Secret handling: secrets stored in `~/.cloudmind/{agent-id}/secrets.json`, never logged or streamed
- [ ] Runtime API port lives only in `runtime/api.port`; service port bindings live only in `containers/registry.jsonl`

### 4.4 Doctor Command
- [ ] `cloudmind doctor <agent-id>` runs a series of checks and prints a status report:
  - Agent process: running / stopped / crashed
  - Security config: present, valid JSON, no unknown keys
  - Workspace: all expected directories exist, no permission errors
  - Config: valid, configured LLM provider reachable (ping with a test request)
  - Memory: working.md exists, episodic current month file writable
  - Containers: cross-reference registry.jsonl with live Docker state, flag drift
  - Scheduled triggers: last run timestamp, next scheduled run
  - Ports: list bound ports, flag any conflicts with other agents
- [ ] Exit code 0 = all healthy, non-zero = issues found (CI-friendly)

**Deliverable**: Two agents running simultaneously, each with their own workspace, containers, and memory. Can start/stop independently.

---

## Phase 5 — Service Containers + Telegram Trigger Adapter

**Goal**: Agent can reliably run long-term services and be reached via Telegram.

### 5.1 Service Container Reliability
- [ ] Auto-restart policy for service containers (`--restart unless-stopped`)
- [ ] Health check polling: agent periodically checks if service containers are still alive
- [ ] Auto-re-register containers that survived a host reboot (reconcile on agent start)

### 5.2 Port Management
- [ ] Port allocator: agent picks the next free host port from a configured range (default: 10000-20000) by inspecting live Docker bindings plus this agent's `containers/registry.jsonl`
- [ ] Persist service port bindings only in `containers/registry.jsonl`; no separate `config.json` port registry
- [ ] `container_status()` shows port mappings
- [ ] Warn user when binding a port (note: firewall/Tailscale config may be needed)

### 5.3 Docker Networks
- [ ] Agent can create a named Docker network per "project"
- [ ] Multiple containers in same project share a network (can talk to each other by container name)
- [ ] Network config stored in registry.jsonl

### 5.4 Telegram Trigger Adapter
- [ ] Document bridge container spec: reads `TELEGRAM_BOT_TOKEN`, `CLOUDMIND_API_URL`, `CLOUDMIND_API_KEY`, and optional `CLOUDMIND_AGENT_ID` from environment; long-polls Telegram Bot API; creates or resumes `sessionId: "telegram:{chat_id}"` with `source.kind = "im"` and `source.platform = "telegram"`; POSTs each Telegram message to `/sessions/{sessionId}/messages`; subscribes to SSE stream; calls Telegram `sendMessage` with the final response
- [ ] Agent starts bridge via `container_start`: inject `TELEGRAM_BOT_TOKEN` from `secrets.json` as `env_secrets`; read actual port from `runtime/api.port` and inject `CLOUDMIND_API_URL=http://host.docker.internal:{port}`, `CLOUDMIND_AGENT_ID` (optional metadata), and `CLOUDMIND_API_KEY` (from `runtime/api.token`) as plain env vars
- [ ] `config.channels.telegram_bridge.enabled` toggle — false by default, user opts in
- [ ] `config.channels.telegram_bridge.allowed_chat_ids` — allowlist enforced by the bridge; empty list rejects all messages (safe default)
- [ ] Session trigger source: bridge always sets `source.interactive = true`
- [ ] Bridge container can be in any language; no Telegram or grammy code exists in the agent process

**Deliverable**: Agent starts a Postgres + web app pair on the same Docker network, exposes the web app on port 10001, and tells the user to run `tailscale funnel 10001` themselves if they want external access. Separately: user sends a message to the Telegram bot, bridge POSTs to the agent HTTP API, agent responds, bridge sends the result back to the Telegram chat.

---

## Phase 6 — Scheduled Sessions (Heartbeat + Cron)

**Goal**: Agent can launch non-interactive scheduled sessions through the same session lifecycle path used by CLI and Telegram.

### 6.1 Scheduled Trigger Runner
- [ ] Implement an in-process scheduler that dispatches scheduled runs through `AgentRunner.openSession()` + `AgentRunner.postMessage()`
- [ ] Allow optional external schedulers (host cron, scheduler container, Kubernetes CronJob) to call the same `SessionSpec + SessionMessage` lifecycle over HTTP instead of using the in-process scheduler
- [ ] Guard: skip overlapping runs for the same scheduled trigger ID
- [ ] Guard: configurable policy for whether scheduled runs may start while an interactive session is active
- [ ] On fire: emit `onScheduleTrigger`, then start the session

### 6.2 Heartbeat Preset
- [ ] Heartbeat is a built-in scheduled trigger with session ID prefix `heartbeat:{ts}`
- [ ] Load `memory/heartbeat.md` (create with defaults if not exists)
- [ ] Build heartbeat prompt: system context + heartbeat.md contents + "check what needs doing", then post it as the first `SessionMessage`
- [ ] Run ReAct loop with `config.heartbeat.max_iterations` cap
- [ ] Restrict available tools to `config.heartbeat.tools_allowed` list
- [ ] Effective heartbeat autonomy comes from `security.json` and is capped at `supervised`; if global autonomy is `readonly`, write tasks are skipped and logged
- [ ] No output streamed to user — all results go to episodic memory only
- [ ] On completion: append `heartbeat_run` event to episodic log with summary

### 6.3 Cron / User-defined Scheduled Jobs
- [ ] Add `config.schedules.jobs[]` definitions with fields like `id`, `schedule`, `prompt`, `enabled`, and `tools_allowed`
- [ ] Each configured job opens a non-interactive `cron:{job-id}:{ts}` session and posts a synthesized first `SessionMessage`
- [ ] Cron jobs reuse the same hooks, memory injection, tool checks, and session logging as every other trigger source
- [ ] Support both prompt-only jobs ("summarise yesterday") and tool-oriented maintenance jobs ("check service drift")

### 6.4 Heartbeat Checklist File — `memory/heartbeat.md`
- [ ] Scaffold default `heartbeat.md` on workspace init with sensible default tasks:
  - Hourly: verify service containers are running
  - Daily: summarise episodic log into a note
  - Daily: clean up old ephemeral container records
  - Weekly: archive old session files
- [ ] Agent updates the "last run" timestamp in heartbeat.md after completing each task
- [ ] `heartbeat.md` is editable by the user to add/remove/customize tasks

### 6.5 Default Heartbeat Tasks (built-in logic)
- [ ] **Container health check**: call `container_status`, log any containers that died unexpectedly, write a note if action needed
- [ ] **Episodic log summary**: read yesterday's episodic events, ask LLM to summarise, write to `memory/notes/daily-{date}.md`
- [ ] **Stale working memory**: if `working.md` hasn't been updated in > 24h and there was recent activity, summarise and refresh it

**Deliverable**: A built-in heartbeat run and a weekly cron-style summary job both execute through the same session lifecycle path (`openSession` + `postMessage`) without introducing a second agent loop.

---

## Phase 7 — Polish + Extensions

**Goal**: Better DX, observability, optional database upgrade.

- [ ] Web UI: simple local dashboard showing agent status, memory, containers, session history — can connect directly to the agent's HTTP API (already available from Phase 2); no additional protocol work needed
- [ ] SQLite upgrade: migrate episodic.jsonl and session logs to SQLite for faster querying
- [ ] Sub-agent support: agent can spawn another agent as a tool call
- [ ] Tool permissions: config-driven allow/deny list per tool
- [ ] Rate limiting / cost tracking: track Claude API token usage per session, warn on high spend
- [ ] Snapshot/restore: zip up entire workspace for backup or migration

---

## Future Phase — Gateway / Control Plane

**Goal**: Add a host-level control plane above many agent-local runtimes without changing the per-agent contract.

- [ ] Agent lifecycle management: create, register, start, stop, and delete multiple agents from one gateway service
- [ ] Multi-agent routing: proxy each agent-local API behind gateway routes like `/agents/{id}/sessions`, `/agents/{id}/sessions/{sessionId}/messages`, and `/agents/{id}/events`
- [ ] Inter-agent communication: define and enforce a protocol for one agent to reach another through the gateway instead of direct port discovery
- [ ] Central trigger management: move channel adapters, heartbeat scheduling, cron jobs, and future triggers into the gateway so individual agents no longer manage them locally
- [ ] Health monitoring: track agent process status, liveness, restart state, and recent failures from one place
- [ ] Compatibility rule: gateway remains a control-plane layer over the existing agent-local API, not a second agent runtime implementation

---

## File Format Reference

### `memory/episodic/2026-03.jsonl`
```jsonl
{"ts":"2026-03-07T10:00:00Z","session":"s1","type":"session_started","data":{}}
{"ts":"2026-03-07T10:00:05Z","session":"s1","type":"message_received","data":{"role":"user","content":"hello"}}
{"ts":"2026-03-07T10:00:08Z","session":"s1","type":"tool_called","data":{"tool":"read_file","args":{"path":"memory/notes/facts.md"}}}
{"ts":"2026-03-07T10:00:09Z","session":"s1","type":"tool_result","data":{"tool":"read_file","result":"..."}}
{"ts":"2026-03-07T10:00:12Z","session":"s1","type":"message_sent","data":{"role":"assistant","content":"Hi!"}}
{"ts":"2026-03-07T10:00:12Z","session":"s1","type":"session_ended","data":{"turns":2}}
{"ts":"2026-03-07T11:00:00Z","session":"heartbeat:1741345200","type":"heartbeat_run","data":{"tasks_checked":3,"tasks_acted":1,"duration_ms":4200}}
```

### `sessions/{date}-{id}.jsonl`
```jsonl
{"ts":"2026-03-07T10:00:05Z","role":"user","content":"Write me a fibonacci script"}
{"ts":"2026-03-07T10:00:08Z","role":"assistant","type":"thought","content":"I should write the script to a file then run it"}
{"ts":"2026-03-07T10:00:08Z","role":"tool_call","name":"write_file","args":{"path":"containers/run-1/data/fib.py","content":"..."}}
{"ts":"2026-03-07T10:00:09Z","role":"tool_result","name":"write_file","content":"ok"}
{"ts":"2026-03-07T10:00:09Z","role":"tool_call","name":"container_run","args":{"image":"python:3.12","command":"python /workspace/fib.py","mount":"containers/run-1/data"}}
{"ts":"2026-03-07T10:00:14Z","role":"tool_result","name":"container_run","content":{"stdout":"1 1 2 3 5...","exitCode":0}}
{"ts":"2026-03-07T10:00:15Z","role":"assistant","type":"answer","content":"Here are the first 20 Fibonacci numbers: ..."}
```

### `containers/registry.jsonl`
```jsonl
{"id":"abc123","name":"pg-main","image":"postgres:16","type":"service","status":"running","description":"Postgres backing store for project-x","ports":{"5432":10001},"mount":"containers/pg-main/data","network":"project-x","created":"2026-03-07T10:00:00Z"}
{"id":"def456","name":"run-1","image":"python:3.12","type":"ephemeral","status":"removed","description":"Ephemeral Python run for Fibonacci verification","created":"2026-03-07T10:05:00Z","removed":"2026-03-07T10:05:03Z"}
```
