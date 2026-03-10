# Development Plan

## Phases Overview

```
Phase 1 — Workspace + Container Primitives
Phase 2 — Agent Core (LLM loop + tools + hook system)
Phase 3 — Memory System (file-based)
Phase 4 — Agent Lifecycle + Config
Phase 5 — Web Client + Service Containers
Phase 6 — Telegram Trigger Adapter + Scheduled Sessions
Phase 7 — Polish (CLI, multi-agent, SQLite upgrade)
```

---

## Phase 1 — Workspace + Container Primitives

**Goal**: Define the workspace layout and prove that the agent can spin up, use, and tear down Docker containers — mounting files from the workspace.

**Current status snapshot**
- Implemented: workspace scaffold, typed config read/write, three-layer path validation, security/secrets loading, readonly/supervised/full policy checks, Docker CLI runner abstraction, container registry with `description`, service start/stop/exec, and core test coverage.
- Still pending: a dedicated end-to-end integration script and any additional ergonomics beyond the current tested primitives.

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
- [ ] Load `~/.openhermit/{agent-id}/security.json` at startup (read-only, never write from agent)
- [ ] Load `~/.openhermit/{agent-id}/secrets.json` at startup into memory (read-only, never logged, never passed to LLM)
- [ ] `security.checkPath(path)` — runs three-layer validation (null byte → workspace boundary → symlink escape); no configurable forbidden-paths list needed — the workspace boundary covers it architecturally
- [ ] `security.getAutonomyLevel()` — returns current level: `readonly | supervised | full`
- [ ] `security.requiresApproval(toolName)` — checks `require_approval_for` list from security config
- [ ] `secrets.resolve(names: string[])` — returns `Record<string, string>` of name → value for use as Docker env vars; throws if any name is not found
- [ ] `secrets.listNames()` — returns key names only (no values), used to inject into system prompt
- [ ] `security.init()` — scaffolds `~/.openhermit/{agent-id}/` directory with default `security.json` and empty `secrets.json` if not exists
- [ ] Tests: path escape via `../`, sibling-prefix roots, symlinks, and null bytes all throw; autonomy level correctly loaded; approval list works; secret values never appear in any return value to LLM layer

### 1.3 Container Manager Module
- [ ] Wrap Docker CLI with typed runner interface
- [ ] `container.runEphemeral({ image, command, description?, mount?, env? })` — run and return output, auto-remove
  - Mount: `workspace/containers/{name}/data/` → `/workspace` in container
  - Parse sentinel markers (`---OPENHERMIT_OUTPUT_START---` / `---OPENHERMIT_OUTPUT_END---`) from stdout
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

**Current status snapshot**
- Implemented: `pi-ai` + `pi-agent-core` integration, runtime system prompt loading from markdown, approval gating, `tool_requested / tool_started / tool_result` event model, agent-local HTTP + SSE API, approval endpoint, session listing, separate `apps/cli` client, and built-in tools for files, containers, `file_search`, and `web_fetch`.
- Still pending: `agent_doctor`, packaged `openhermit` commands, a browser-based client, and a fuller hook/config story beyond the current built-in approval/logging path.

### 2.1 Integrate pi-ai + pi-agent-core
- [ ] `npm install @mariozechner/pi-ai @mariozechner/pi-agent-core`
- [ ] Define `config.model` as a structured provider/model object, e.g. `{ "provider": "anthropic", "model": "claude-sonnet-4-5", "max_tokens": 8192 }`
- [ ] Provider API keys (for pi-ai) read from `~/.openhermit/{agent-id}/secrets.json` at startup — same secrets store, same loading path as other credentials
- [ ] `transformContext` callback: fires before every LLM call, injects fresh context:
  - Load `identity/IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md` into system prompt
  - Load `memory/working.md` as first user-side context block
  - Inject note filenames so agent knows what topics it has stored
- [ ] Event → hook wiring (pi-agent-core events mapped to OpenHermit lifecycle hooks):
  - `agent_start` → `onSessionStart`
  - `tool_execution_start` → `beforeToolCall`
  - `tool_execution_end` → `afterToolCall`
  - `agent_end` → `onSessionEnd`
  - `error` → `onError`
- [ ] Model switching helper: `agent.setModel(getModel(provider, model))` exposed as `openhermit model set <agent-id> <provider> <model> [--max-tokens N]`
- [ ] `openhermit models` command — lists all pi-ai supported models + current selection
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
  - `file_search(pattern, path?, glob?)` — ripgrep-like text search across workspace files
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
- [ ] Define `OutboundEvent` SSE types: `text_delta | text_final | tool_requested | tool_started | tool_result | error`
- [ ] Expose `AgentRunner.openSession(spec)` and `AgentRunner.postMessage(sessionId, message)` inside the agent process; all adapters call this lifecycle interface
- [ ] Implement Hono HTTP adapter inside the agent process:
  - `POST /sessions` — validates bearer token, accepts `SessionSpec`, creates or resumes the session, returns `{ sessionId }`
  - `GET /sessions` — validates bearer token, lists sessions known to this agent; supports filters like `kind`, `platform`, `interactive`, `limit`; default sort is `lastActivityAt desc`
  - `POST /sessions/{sessionId}/messages` — validates bearer token, accepts `SessionMessage`, appends one inbound message, returns `{ sessionId, messageId? }`
  - `POST /sessions/{sessionId}/approve` — validates bearer token, resolves one pending tool approval, returns `{ resolved }`
  - `GET /events?sessionId=xxx` — SSE stream, pushes `OutboundEvent`s as the agent processes the session
- [ ] Runtime API token: generate on startup, write to `runtime/api.token` (create `runtime/` dir, add to `.gitignore`)
- [ ] Dynamic port binding: try `config.http_api.preferred_port` first; if taken, bind to port `0` (OS assigns free port); write actual port to `runtime/api.port` — guarantees zero conflicts when multiple agents run on the same host
- [ ] Treat the HTTP API as agent-local: clients first choose the target agent by reading its workspace/runtime metadata, then talk to that agent's local port directly; route paths do not repeat `{agentId}`
- [ ] CLI client (`apps/cli` today; future packaged as `openhermit chat --agent <id>`): reads `runtime/api.port` and `runtime/api.token`, creates a new `source.kind = "cli"` session by default, supports `/new`, `/sessions`, `/resume <id>`, `--session <id>`, and `--resume`, subscribes to SSE, then posts the first and subsequent user messages to `/sessions/{sessionId}/messages`
- [ ] `openhermit run --agent <id> "task"` — same as above but single-shot (no readline loop)
- [ ] Scheduled triggers in Phase 6 reuse the same `SessionSpec + SessionMessage` lifecycle in-process or over HTTP; no second execution path
- [ ] `openhermit models` — list all available models across providers
- [ ] `openhermit model set <agent-id> <provider> <model> [--max-tokens N]` — switch model at runtime via `agent.setModel()`
- [ ] `openhermit model get <agent-id>` — show current model

**Deliverable**: "Write a Python script that generates the first 20 Fibonacci numbers, run it, and show me the output." → agent writes file into an ephemeral run mount → spawns container → runs script → hooks fire → result streams to terminal via SSE. Run the same task with a different configured model (for example `openai gpt-4o`) to verify multi-provider works.

---

## Phase 3 — Memory System

**Goal**: Agent reads/writes memory files correctly, context stays coherent across tool calls and sessions.

**Current status snapshot**
- Implemented: session logs, durable `sessions/index.json`, working memory injection, scaffolded `memory/long-term.md`, session metadata such as descriptions for easier recall/resume, and the `file_search` tool needed for memory retrieval.
- Still pending: checkpoint summarization, working-memory maintenance, and a cleaner episodic/long-term promotion flow.

### 3.1 Working Memory
- [ ] Load `memory/working.md` at session start → inject into system prompt
- [ ] Agent rewrites `memory/working.md` using normal file tools (`read_file` / `write_file`)
- [ ] Auto-prompt agent to update working memory at session end if context changed significantly
- [ ] Keep working.md under a token limit (warn agent if it's growing too large)

### 3.2 Episodic Memory
- [ ] Write to `memory/episodic/{YYYY-MM}.jsonl` — auto-create new file each month
- [ ] Episodic memory is summary-oriented, not a raw mirror of `sessions/*.jsonl`
- [ ] Summarization triggers:
  - once when a session becomes idle for a configurable timeout
  - once every 50 conversation turns for a long-running session
- [ ] `/new` switches the adapter binding to a fresh session; it does not close the previous session
- [ ] All writes go through the `log` / summarization path rather than direct ad hoc episodic writes
- [ ] Event schema: `{ ts, session, type, data }`
- [ ] Agent queries episodic history through normal file reads plus `file_search`

### 3.3 Long-Term Memory
- [ ] Add `memory/long-term.md` as the entry point and index for long-term memory
- [ ] Store topic files under `memory/notes/*.md`
- [ ] Long-term memory is managed through existing file tools (`read_file`, `write_file`, `list_files`) plus `file_search`
- [ ] Inject `memory/long-term.md` and relevant note filenames (not all note content) into context so agent knows what stable knowledge exists

### 3.4 Session Log
- [ ] Auto-create `sessions/{date}-{id}.jsonl` at session start
- [ ] Maintain `sessions/index.json` as the durable session metadata index used for listing and resume
- [ ] Append every message + tool call/result during session
- [ ] Store session `description` metadata so session lists are easy to scan and recover
- [ ] Session checkpoint summary: when a session goes idle, generate an episodic summary entry
- [ ] Long sessions also emit intermediate episodic summaries every 50 turns

**Deliverable**: Agent remembers a user's name and preferred programming language across two separate sessions without being told again.

---

## Phase 4 — Agent Lifecycle + Config

**Goal**: Multiple named agents, clean start/stop, persistent state across process restarts.

### 4.1 Agent Registry
- [ ] Global registry at `~/openhermit/agents.jsonl` — list of all agents + workspace paths
- [ ] `openhermit agent create --name "My Agent"` — scaffold workspace + register
- [ ] `openhermit agent list` — show all agents + status
- [ ] `openhermit agent delete <id>` — remove workspace + registry entry

### 4.2 Process Management
- [ ] `openhermit start <agent-id>` — start agent as background process (pm2 or simple fork)
- [ ] `openhermit stop <agent-id>` — graceful shutdown
- [ ] On startup: reconcile container registry with live Docker state (mark dead containers as removed)
- [ ] On shutdown: leave service containers running unless they were explicitly stopped, and record shutdown in episodic log

### 4.3 Config Management
- [ ] `openhermit config set <agent-id> <key> <value>` — update config.json
- [ ] `openhermit security edit <agent-id>` — open `~/.openhermit/{id}/security.json` in $EDITOR
- [ ] Secret handling: secrets stored in `~/.openhermit/{agent-id}/secrets.json`, never logged or streamed
- [ ] Runtime API port lives only in `runtime/api.port`; service port bindings live only in `containers/registry.jsonl`

### 4.4 Doctor Command
- [ ] `openhermit doctor <agent-id>` runs a series of checks and prints a status report:
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

## Phase 5 — Web Client + Service Containers

**Goal**: Agent can be used from both CLI and Web, and can reliably run long-term services needed by user tasks.

### 5.1 Web Client
- [ ] Add `apps/web` as a first-party browser client for the agent-local API
- [ ] Build a simple chat UI:
  - session list ordered by `lastActivityAt desc`
  - create new session action
  - resume existing session action
  - message composer + streaming assistant output
  - tool activity feed using the same SSE events already used by CLI
- [ ] Web client should treat session binding the same way as CLI:
  - one currently selected session in the browser UI
  - "New session" creates a fresh session and switches the binding
  - old sessions remain resumable
- [ ] Web client talks directly to the existing agent-local HTTP + SSE API; no gateway dependency
- [ ] Keep the first version local-first and minimal: no auth beyond the existing agent token, no multi-user model, no extra backend
- [ ] Reuse `packages/sdk` and `packages/protocol` rather than inventing a web-only API client

**Deliverable**: open `apps/web`, see a sessions sidebar, start a new session, resume an old one, and complete a streamed chat turn against the same agent-local API the CLI uses.

### 5.2 Service Container Reliability
- [ ] Auto-restart policy for service containers (`--restart unless-stopped`)
- [ ] Health check polling: agent periodically checks if service containers are still alive
- [ ] Auto-re-register containers that survived a host reboot (reconcile on agent start)

### 5.3 Port Management
- [ ] Port allocator: agent picks the next free host port from a configured range (default: 10000-20000) by inspecting live Docker bindings plus this agent's `containers/registry.jsonl`
- [ ] Persist service port bindings only in `containers/registry.jsonl`; no separate `config.json` port registry
- [ ] `container_status()` shows port mappings
- [ ] Warn user when binding a port (note: firewall/Tailscale config may be needed)

### 5.4 Docker Networks
- [ ] Agent can create a named Docker network per "project"
- [ ] Multiple containers in same project share a network (can talk to each other by container name)
- [ ] Network config stored in registry.jsonl

**Deliverable**: OpenHermit serves a local web chat UI backed by the same agent-local API as the CLI, and the agent can start a Postgres + web app pair on the same Docker network, expose the web app on port 10001, and tell the user to run `tailscale funnel 10001` themselves if they want external access.

---

## Phase 6 — Telegram Trigger Adapter + Scheduled Sessions

**Goal**: Add the first IM channel and non-interactive scheduled sessions on top of the same session lifecycle already used by CLI and Web.

### 6.1 Telegram Trigger Adapter
- [ ] Document bridge container spec: reads `TELEGRAM_BOT_TOKEN`, `OPENHERMIT_API_URL`, `OPENHERMIT_API_KEY`, and optional `OPENHERMIT_AGENT_ID` from environment; long-polls Telegram Bot API; creates or resumes `sessionId: "telegram:{chat_id}"` with `source.kind = "im"` and `source.platform = "telegram"`; POSTs each Telegram message to `/sessions/{sessionId}/messages`; subscribes to SSE stream; calls Telegram `sendMessage` with the final response
- [ ] Agent starts bridge via `container_start`: inject `TELEGRAM_BOT_TOKEN` from `secrets.json` as `env_secrets`; read actual port from `runtime/api.port` and inject `OPENHERMIT_API_URL=http://host.docker.internal:{port}`, `OPENHERMIT_AGENT_ID` (optional metadata), and `OPENHERMIT_API_KEY` (from `runtime/api.token`) as plain env vars
- [ ] `config.channels.telegram_bridge.enabled` toggle — false by default, user opts in
- [ ] `config.channels.telegram_bridge.allowed_chat_ids` — allowlist enforced by the bridge; empty list rejects all messages (safe default)
- [ ] Session trigger source: bridge always sets `source.interactive = true`
- [ ] Bridge container can be in any language; no Telegram or grammy code exists in the agent process

### 6.2 Scheduled Trigger Runner
- [ ] Implement an in-process scheduler that dispatches scheduled runs through `AgentRunner.openSession()` + `AgentRunner.postMessage()`
- [ ] Allow optional external schedulers (host cron, scheduler container, Kubernetes CronJob) to call the same `SessionSpec + SessionMessage` lifecycle over HTTP instead of using the in-process scheduler
- [ ] Guard: skip overlapping runs for the same scheduled trigger ID
- [ ] Guard: configurable policy for whether scheduled runs may start while an interactive session is active
- [ ] On fire: emit `onScheduleTrigger`, then start the session

### 6.3 Heartbeat Preset
- [ ] Heartbeat is a built-in scheduled trigger with session ID prefix `heartbeat:{ts}`
- [ ] Load `memory/heartbeat.md` (create with defaults if not exists)
- [ ] Build heartbeat prompt: system context + heartbeat.md contents + "check what needs doing", then post it as the first `SessionMessage`
- [ ] Run ReAct loop with `config.heartbeat.max_iterations` cap
- [ ] Restrict available tools to `config.heartbeat.tools_allowed` list
- [ ] Effective heartbeat autonomy comes from `security.json` and is capped at `supervised`; if global autonomy is `readonly`, write tasks are skipped and logged
- [ ] No output streamed to user — all results go to episodic memory only
- [ ] On completion: append `heartbeat_run` event to episodic log with summary

### 6.4 Cron / User-defined Scheduled Jobs
- [ ] Add `config.schedules.jobs[]` definitions with fields like `id`, `schedule`, `prompt`, `enabled`, and `tools_allowed`
- [ ] Each configured job opens a non-interactive `cron:{job-id}:{ts}` session and posts a synthesized first `SessionMessage`
- [ ] Cron jobs reuse the same hooks, memory injection, tool checks, and session logging as every other trigger source
- [ ] Support both prompt-only jobs ("summarise yesterday") and tool-oriented maintenance jobs ("check service drift")

### 6.5 Heartbeat Checklist File — `memory/heartbeat.md`
- [ ] Scaffold default `heartbeat.md` on workspace init with sensible default tasks:
  - Hourly: verify service containers are running
  - Daily: summarise episodic log into a note
  - Daily: clean up old ephemeral container records
  - Weekly: archive old session files
- [ ] Agent updates the "last run" timestamp in heartbeat.md after completing each task
- [ ] `heartbeat.md` is editable by the user to add/remove/customize tasks

### 6.6 Default Heartbeat Tasks (built-in logic)
- [ ] **Container health check**: call `container_status`, log any containers that died unexpectedly, write a note if action needed
- [ ] **Episodic log summary**: read yesterday's episodic events, ask LLM to summarise, write to `memory/notes/daily-{date}.md`
- [ ] **Stale working memory**: if `working.md` hasn't been updated in > 24h and there was recent activity, summarise and refresh it

**Deliverable**: User sends a message to the Telegram bot, bridge POSTs to the agent HTTP API, agent responds, bridge sends the result back to Telegram. Separately, a built-in heartbeat run and a weekly cron-style summary job both execute through the same session lifecycle path (`openSession` + `postMessage`) without introducing a second agent loop.

---

## Phase 7 — Polish + Extensions

**Goal**: Better DX, observability, optional database upgrade.

- [ ] Web UI expansion: move beyond basic chat into a fuller local dashboard for memory, containers, and agent status
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
{"ts":"2026-03-07T10:00:12Z","session":"s1","type":"session_summary","data":{"turns":2,"summary":"User asked for a fibonacci script; agent wrote it, tested it, and confirmed the output."}}
{"ts":"2026-03-07T11:45:00Z","session":"s2","type":"session_checkpoint","data":{"turns":50,"summary":"Long debugging session: narrowed the issue to Docker mount validation and approval event ordering."}}
{"ts":"2026-03-07T11:00:00Z","session":"heartbeat:1741345200","type":"heartbeat_run","data":{"tasks_checked":3,"tasks_acted":1,"duration_ms":4200}}
```

### `sessions/{date}-{id}.jsonl`
```jsonl
{"ts":"2026-03-07T10:00:05Z","role":"user","content":"Write me a fibonacci script"}
{"ts":"2026-03-07T10:00:08Z","role":"assistant","type":"thought","content":"I should write the script to a file then run it"}
{"ts":"2026-03-07T10:00:08Z","role":"tool_call","type":"tool_requested","name":"write_file","args":{"path":"containers/run-1/data/fib.py","content":"..."}}
{"ts":"2026-03-07T10:00:08Z","role":"tool_call","type":"tool_started","name":"write_file","args":{"path":"containers/run-1/data/fib.py","content":"..."}}
{"ts":"2026-03-07T10:00:09Z","role":"tool_result","name":"write_file","content":"ok"}
{"ts":"2026-03-07T10:00:09Z","role":"tool_call","type":"tool_requested","name":"container_run","args":{"image":"python:3.12","command":"python /workspace/fib.py","mount":"containers/run-1/data"}}
{"ts":"2026-03-07T10:00:09Z","role":"tool_call","type":"tool_started","name":"container_run","args":{"image":"python:3.12","command":"python /workspace/fib.py","mount":"containers/run-1/data"}}
{"ts":"2026-03-07T10:00:14Z","role":"tool_result","name":"container_run","content":{"stdout":"1 1 2 3 5...","exitCode":0}}
{"ts":"2026-03-07T10:00:15Z","role":"assistant","type":"answer","content":"Here are the first 20 Fibonacci numbers: ..."}
```

### `containers/registry.jsonl`
```jsonl
{"id":"abc123","name":"pg-main","image":"postgres:16","type":"service","status":"running","description":"Postgres backing store for project-x","ports":{"5432":10001},"mount":"containers/pg-main/data","network":"project-x","created":"2026-03-07T10:00:00Z"}
{"id":"def456","name":"run-1","image":"python:3.12","type":"ephemeral","status":"removed","description":"Ephemeral Python run for Fibonacci verification","created":"2026-03-07T10:05:00Z","removed":"2026-03-07T10:05:03Z"}
```
