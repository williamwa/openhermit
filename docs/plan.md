# Development Plan

## Phases Overview

```
Phase 1 — Workspace + Container Primitives
Phase 2 — Agent Core (LLM loop + tools + hook system)
Phase 3 — Memory System (file-based)
Phase 4 — Heartbeat Engine
Phase 5 — Agent Lifecycle + Config
Phase 6 — Service Containers + Port Management
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
  - Layer 2: workspace boundary check (`resolved.startsWith(workspaceRoot)` → throw if not)
  - Layer 3: symlink escape check (`fs.realpathSync(resolved).startsWith(workspaceRoot)` → throw if not)
- [ ] Tests: path escape via `../`, symlinks, and null bytes all throw

### 1.2 Security + Secrets Module
- [ ] Load `~/.cloudmind/{agent-id}/security.json` at startup (read-only, never write from agent)
- [ ] Load `~/.cloudmind/{agent-id}/secrets.json` at startup into memory (read-only, never logged, never passed to LLM)
- [ ] `security.checkPath(path)` — runs three-layer validation (null byte → workspace boundary → symlink escape); no configurable forbidden-paths list needed — the workspace boundary covers it architecturally
- [ ] `security.getAutonomyLevel()` — returns current level: `readonly | supervised | full`
- [ ] `security.requiresApproval(toolName)` — checks `require_approval_for` list from security config
- [ ] `secrets.resolve(names: string[])` — returns `Record<string, string>` of name → value for use as Docker env vars; throws if any name is not found
- [ ] `secrets.listNames()` — returns key names only (no values), used to inject into system prompt
- [ ] `security.init()` — scaffolds `~/.cloudmind/{agent-id}/` directory with default `security.json` and empty `secrets.json` if not exists
- [ ] Tests: path escape via `../`, symlinks, and null bytes all throw; autonomy level correctly loaded; approval list works; secret values never appear in any return value to LLM layer

### 1.3 Container Manager Module
- [ ] Wrap Dockerode with typed interface
- [ ] `container.runEphemeral({ image, command, mount?, env? })` — run and return output, auto-remove
  - Mount: `workspace/containers/{name}/data/` → `/workspace` in container
  - Parse sentinel markers (`---CLOUDMIND_OUTPUT_START---` / `---CLOUDMIND_OUTPUT_END---`) from stdout
  - Return: `{ stdout, stderr, exitCode, durationMs, parsedOutput? }`
  - Validate mount path through `security.checkPath()` before passing to Docker
- [ ] `container.startService({ image, name, mount?, ports?, env? })` — start long-running container
- [ ] `container.stopService(name)` — stop + remove service container
- [ ] `container.execInService(name, command)` — exec command in running container
- [ ] `container.listAll()` — return all containers from registry.jsonl + live Docker status
- [ ] Write to `containers/registry.jsonl` on every create/stop/remove

### 1.4 Integration test
- [ ] Init workspace → run `python:3.12` ephemeral container → execute `print("hello")` → assert output
- [ ] Init workspace → write file to `containers/test/data/input.txt` → run container that reads it → assert output
- [ ] Start postgres service container → verify it's in registry → stop it → verify removed

**Deliverable**: A test script that proves workspace isolation and container lifecycle work end-to-end.

---

## Phase 2 — Agent Core (pi-ai + pi-agent-core + Tools)

**Goal**: A running agent that receives a message, thinks, calls tools, executes them, and returns an answer — built on `@mariozechner/pi-ai` (multi-provider LLM abstraction) and `@mariozechner/pi-agent-core` (stateful tool-calling loop), not a custom ReAct implementation.

### 2.1 Integrate pi-ai + pi-agent-core
- [ ] `npm install @mariozechner/pi-ai @mariozechner/pi-agent-core`
- [ ] Define `config.model` as a pi-ai model string (e.g. `"claude-sonnet-4-5"`, `"gpt-4o"`, `"gemini-2.0-flash"`)
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
- [ ] Model switching helper: `agent.setModel(modelString)` exposed as `cloudmind model set <agent-id> <model>`
- [ ] `cloudmind models` command — lists all pi-ai supported models + current selection
- [ ] Cost tracking: accumulate pi-ai `usage` events per session; write summary to episodic log at session end

### 2.2 Tool Definitions (TypeBox / AgentTool format)
- [ ] Define all tools as `AgentTool` objects (TypeBox schema + handler), registered with pi-agent-core
- [ ] All tools check `security.getAutonomyLevel()` — `readonly` mode blocks write/exec tools immediately
- [ ] Built-in tools wired up to workspace + container modules:
  - `read_file(path)` — reads file from workspace (path through `security.checkPath()`)
  - `write_file(path, content)` — writes file to workspace (path through `security.checkPath()`)
  - `list_files(dir)` — lists workspace directory
  - `container_run(image, command, env_secrets?, workdir?)` — ephemeral container run; `env_secrets` names resolved via `secrets.resolve()` and injected as Docker env vars
  - `container_start(name, image, ports?, env?, env_secrets?)` — start service container; `env_secrets` names resolved at launch, values never returned to LLM
  - `container_stop(name)` — stop service container
  - `container_exec(name, command)` — exec in running container
  - `container_status()` — list containers + status
  - `web_fetch(url)` — HTTP GET, return body as text
  - `tailscale_funnel(port, enable)` — run `tailscale funnel {port}` or `tailscale funnel --bg {port}`
  - `agent_doctor()` — self-diagnostics (see Phase 5)

### 2.3 Hook System
- [ ] Define hook point enum: `onSessionStart | onSessionEnd | beforeInbound | beforeToolCall | afterToolCall | beforeOutbound | onHeartbeat | onError`
- [ ] Hook registry: map each hook point → ordered list of async handler functions
- [ ] Hook runner: `runHooks(point, context)` — execute handlers in order, stop chain if any throws
- [ ] Built-in handler: `log` — appends event to episodic memory (replaces all manual episodic writes)
- [ ] Built-in handler: `require-approval` — pauses `beforeToolCall`, prints tool name + args to user, waits for y/n confirmation
- [ ] Wire hooks to pi-agent-core events at all defined hook points
- [ ] Load hook config from `config.json` at agent startup
- [ ] Custom hooks: load user-defined handler files from `hooks/` directory (Phase 6+, skip for now)

### 2.4 Basic Interface
- [ ] CLI: `cloudmind chat --agent <id>` — interactive REPL (stream pi-agent-core events to terminal)
- [ ] Single-shot: `cloudmind run --agent <id> "do this task"` → output + exit
- [ ] `cloudmind models` — list all available models across providers
- [ ] `cloudmind model set <agent-id> <model>` — switch model at runtime via `agent.setModel()`
- [ ] `cloudmind model get <agent-id>` — show current model

**Deliverable**: "Write a Python script that generates the first 20 Fibonacci numbers, run it, and show me the output." → agent writes file → spawns container → runs script → `beforeToolCall` hook fires (logs tool call) → returns result → `afterToolCall` hook fires (logs result). Run the same task with a different provider (`--model gpt-4o`) to verify multi-provider works.

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
- [ ] Event schema: `{ ts, session_id, type, data }`
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

## Phase 4 — Heartbeat Engine

**Goal**: Agent wakes up on a timer, reads its own checklist, and does useful background work autonomously.

### 4.1 Heartbeat Timer
- [ ] Background `setInterval` (or cron-style) timer, interval from `config.heartbeat.interval_minutes`
- [ ] Guard: skip if a heartbeat run is already in progress (no overlapping runs)
- [ ] Guard: skip if agent is currently in an active user session (avoid interference)
- [ ] On fire: emit `onHeartbeat` hook, then start heartbeat session

### 4.2 Heartbeat Session
- [ ] Assign a dedicated session ID with prefix `heartbeat-{ts}`
- [ ] Load `memory/heartbeat.md` (create with defaults if not exists)
- [ ] Build heartbeat prompt: system context + heartbeat.md contents + "check what needs doing"
- [ ] Run ReAct loop with `config.heartbeat.max_iterations` cap
- [ ] Restrict available tools to `config.heartbeat.tools_allowed` list
- [ ] No output streamed to user — all results go to episodic memory only
- [ ] On completion: append `heartbeat_run` event to episodic log with summary

### 4.3 Heartbeat Checklist File — `memory/heartbeat.md`
- [ ] Scaffold default `heartbeat.md` on workspace init with sensible default tasks:
  - Hourly: verify service containers are running
  - Daily: summarise episodic log into a note
  - Daily: clean up old ephemeral container records
  - Weekly: archive old session files
- [ ] Agent updates the "last run" timestamp in heartbeat.md after completing each task
- [ ] `heartbeat.md` is editable by the user to add/remove/customize tasks

### 4.4 Default Heartbeat Tasks (built-in logic)
- [ ] **Container health check**: call `container_status`, log any containers that died unexpectedly, write a note if action needed
- [ ] **Episodic log summary**: read yesterday's episodic events, ask LLM to summarise, write to `memory/notes/daily-{date}.md`
- [ ] **Stale working memory**: if `working.md` hasn't been updated in > 24h and there was recent activity, summarise and refresh it

**Deliverable**: Agent left running overnight automatically summarises the previous day's activity into `memory/notes/daily-2026-03-07.md` without any user prompt.

---

## Phase 5 — Agent Lifecycle + Config

**Goal**: Multiple named agents, clean start/stop, persistent state across process restarts.

### 5.1 Agent Registry
- [ ] Global registry at `~/cloudmind/agents.jsonl` — list of all agents + workspace paths
- [ ] `cloudmind agent create --name "My Agent"` — scaffold workspace + register
- [ ] `cloudmind agent list` — show all agents + status
- [ ] `cloudmind agent delete <id>` — remove workspace + registry entry

### 5.2 Process Management
- [ ] `cloudmind start <agent-id>` — start agent as background process (pm2 or simple fork)
- [ ] `cloudmind stop <agent-id>` — graceful shutdown
- [ ] On startup: reconcile container registry with live Docker state (mark dead containers as removed)
- [ ] On shutdown: pause service containers (keep data), record shutdown in episodic log

### 5.3 Config Management
- [ ] `cloudmind config set <agent-id> <key> <value>` — update config.json
- [ ] `cloudmind security edit <agent-id>` — open `~/.config/cloudmind/{id}.security.json` in $EDITOR
- [ ] Secret handling: secrets stored in config.json under `secrets`, never logged or streamed
- [ ] Port registry: track which host ports are claimed across all agents to avoid conflicts

### 5.4 Doctor Command
- [ ] `cloudmind doctor <agent-id>` runs a series of checks and prints a status report:
  - Agent process: running / stopped / crashed
  - Security config: present, valid JSON, no unknown keys
  - Workspace: all expected directories exist, no permission errors
  - Config: valid, model reachable (ping Claude API)
  - Memory: working.md exists, episodic current month file writable
  - Containers: cross-reference registry.jsonl with live Docker state, flag drift
  - Heartbeat: last run timestamp, next scheduled run
  - Ports: list bound ports, flag any conflicts with other agents
- [ ] Exit code 0 = all healthy, non-zero = issues found (CI-friendly)

**Deliverable**: Two agents running simultaneously, each with their own workspace, containers, and memory. Can start/stop independently.

---

## Phase 6 — Service Containers + Port Management

**Goal**: Agent can reliably run long-term services, expose them to the network, and manage them across restarts.

### 6.1 Service Container Reliability
- [ ] Auto-restart policy for service containers (`--restart unless-stopped`)
- [ ] Health check polling: agent periodically checks if service containers are still alive
- [ ] Auto-re-register containers that survived a host reboot (reconcile on agent start)

### 6.2 Port Management
- [ ] Port allocator: agent picks next free port from a configured range (default: 10000-20000)
- [ ] Port registry in config.json: `{ "used": { "pg-project-x": 10001 } }`
- [ ] `container_status()` shows port mappings
- [ ] Warn user when binding a port (note: firewall/Tailscale config may be needed)

### 6.3 Tailscale Integration
- [ ] `tailscale_funnel(port, enable)` tool — directly runs `tailscale funnel` (no sudo needed, ordinary user command)
- [ ] `tailscale_funnel_status()` tool — reads current funnel config via `tailscale funnel status --json`
- [ ] On `container_start` with port binding: suggest running `tailscale_funnel` if user may want external access
- [ ] Track funneled ports in `config.port_registry.funneled` array

### 6.4 Docker Networks
- [ ] Agent can create a named Docker network per "project"
- [ ] Multiple containers in same project share a network (can talk to each other by container name)
- [ ] Network config stored in registry.jsonl

**Deliverable**: Agent starts a Postgres + web app pair on the same Docker network, exposes the web app on port 10001, advises user to run `tailscale funnel 10001`.

---

## Phase 7 — Polish + Extensions

**Goal**: Better DX, observability, optional database upgrade.

- [ ] Web UI: simple local dashboard showing agent status, memory, containers, session history
- [ ] SQLite upgrade: migrate episodic.jsonl and session logs to SQLite for faster querying
- [ ] Sub-agent support: agent can spawn another agent as a tool call
- [ ] Tool permissions: config-driven allow/deny list per tool
- [ ] Rate limiting / cost tracking: track Claude API token usage per session, warn on high spend
- [ ] Snapshot/restore: zip up entire workspace for backup or migration

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
{"ts":"2026-03-07T11:00:00Z","session":"heartbeat-1741345200","type":"heartbeat_run","data":{"tasks_checked":3,"tasks_acted":1,"duration_ms":4200}}
```

### `sessions/{date}-{id}.jsonl`
```jsonl
{"ts":"2026-03-07T10:00:05Z","role":"user","content":"Write me a fibonacci script"}
{"ts":"2026-03-07T10:00:08Z","role":"assistant","type":"thought","content":"I should write the script to a file then run it"}
{"ts":"2026-03-07T10:00:08Z","role":"tool_call","name":"write_file","args":{"path":"files/fib.py","content":"..."}}
{"ts":"2026-03-07T10:00:09Z","role":"tool_result","name":"write_file","content":"ok"}
{"ts":"2026-03-07T10:00:09Z","role":"tool_call","name":"container_run","args":{"image":"python:3.12","command":"python /workspace/fib.py","mount":"files"}}
{"ts":"2026-03-07T10:00:14Z","role":"tool_result","name":"container_run","content":{"stdout":"1 1 2 3 5...","exitCode":0}}
{"ts":"2026-03-07T10:00:15Z","role":"assistant","type":"answer","content":"Here are the first 20 Fibonacci numbers: ..."}
```

### `containers/registry.jsonl`
```jsonl
{"id":"abc123","name":"pg-main","image":"postgres:16","type":"service","status":"running","ports":{"5432":10001},"mount":"containers/pg-main/data","network":"project-x","created":"2026-03-07T10:00:00Z"}
{"id":"def456","name":"run-1","image":"python:3.12","type":"ephemeral","status":"removed","created":"2026-03-07T10:05:00Z","removed":"2026-03-07T10:05:03Z"}
```
