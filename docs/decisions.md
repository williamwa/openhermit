# Architecture Decision Records

---

## ADR-001: Agent runs on host, containers are tools

**Decision**: The agent process runs on the host machine. Docker containers are not the agent — they are sandboxed workers the agent dispatches tasks to.

**Rationale**:
- Agent needs persistent memory and state that survives container restarts
- Agent must manage Docker itself; running inside Docker to manage Docker is awkward
- All file I/O, memory, and config stay on the host under the agent's workspace

---

## ADR-002: File-based memory, no database in v1

**Decision**: All memory and session data stored as plain files. No database dependency.

| Data | Format |
|------|--------|
| Working memory | `memory/working.md` |
| Long-term notes | `memory/notes/{topic}.md` |
| Episodic log | `memory/episodic/{YYYY-MM}.jsonl` (monthly split) |
| Session history | `sessions/{date}-{id}.jsonl` |
| Container registry | `containers/registry.jsonl` |

**Rationale**:
- Zero infrastructure to set up or maintain
- Files are directly readable and editable by both human and LLM
- Easy to back up (zip the workspace directory)
- Upgrade path: migrate JSONL to SQLite in a later phase if query performance becomes a bottleneck

---

## ADR-003: One workspace per agent, strict boundary enforcement

**Decision**: Each agent owns exactly one workspace directory (`~/cloudmind/agents/{agent-id}/`). All reads and writes are confined to this directory. Container mounts only point into `containers/{name}/data/`.

**Rationale**:
- Prevents agents from accidentally or intentionally modifying unrelated host files
- Backup and restore are trivial: one directory = one complete agent
- Clear audit surface: everything the agent did is visible in its workspace

---

## ADR-004: Two container types — ephemeral and service

**Decision**: Containers are either ephemeral (run → output → auto-removed) or service (long-running, port-bound, persisted across restarts).

| | Ephemeral | Service |
|--|-----------|---------|
| Lifetime | Single command | Until explicitly stopped |
| Auto-remove | Yes (`--rm`) | No |
| Port bindings | No | Yes |
| Restart policy | None | `unless-stopped` |

**Rationale**: The two use cases have fundamentally different lifecycle requirements; conflating them adds unnecessary complexity to both.

---

## ADR-005: Agent has no host system commands

**Decision**: The agent has no tools that execute commands on the host system. Its tools are scoped exclusively to workspace file operations and Docker container management. The agent never runs host-level commands — not sudo, not firewall rules, not `tailscale funnel`, nothing.

**Rationale**:
- Principle of least privilege: the agent's job is workspace and container management, not host administration
- Keeping host commands out of the tool set eliminates an entire class of unintended side-effects
- For anything host-level (including Tailscale Funnel), the agent informs the user of the exact command to run themselves — e.g. "run `tailscale funnel 10001` to expose this service externally"
- This keeps the trust boundary clean: the agent controls its sandbox; the user controls the host

---

## ADR-006: TypeScript + Node.js runtime

**Decision**: The entire agent runtime is Node.js TypeScript. Container workloads can use any language.

**Rationale**:
- Single language across the whole codebase
- pi-ai and pi-agent-core are TypeScript-native
- Strong typing makes tool schema generation and path validation straightforward
- Rich async/streaming ecosystem (Dockerode, Hono, etc.)

---

## ADR-007: External config directory `~/.cloudmind/{agent-id}/`

**Decision**: Security policy and secrets live outside the workspace in `~/.cloudmind/{agent-id}/`, never inside the workspace the agent can write to.

```
~/.cloudmind/{agent-id}/
├── security.json   # autonomy_level + require_approval_for
└── secrets.json    # API keys, tokens, passwords
```

**`security.json` contains only**:
- `autonomy_level` (`readonly | supervised | full`) — if this were inside the workspace, the agent could write-escalate itself from `supervised` to `full`
- `require_approval_for` — list of tools that always require confirmation; same risk applies

**`security.json` does NOT contain** `forbidden_paths` or `allowed_commands` — both are redundant given the architecture:
- Path access is structurally blocked by three-layer workspace boundary validation (not a config list)
- Container commands run inside Docker with only the mounted `containers/{name}/data/` dir accessible — no host path reachable regardless of what command runs

**`secrets.json`**: Credentials the agent's containers may need. The LLM **never sees values** — only key names injected into system prompt as a reference list. Values flow: `secrets.json → agent memory → Docker --env → container process`.

---

## ADR-008: Three-layer path validation (hardcoded, not configurable)

**Decision**: Every file path goes through three mandatory checks before use:
1. **Null byte** — `path.includes('\0')` → reject
2. **Workspace boundary** — `resolve(root, path).startsWith(workspaceRoot)` → reject if not
3. **Symlink escape** — `realpathSync(resolved).startsWith(workspaceRoot)` → reject if not

**Rationale**: Each layer catches a distinct attack class. Layer 2 alone is bypassed by a symlink inside the workspace pointing outside; layer 3 catches that. All three are required.

---

## ADR-009: Three autonomy levels

**Decision**: Agent operates at `readonly`, `supervised` (default), or `full` — configured in `security.json`. Heartbeat sessions are capped at `supervised`, never `full`.

| Level | Behaviour |
|-------|-----------|
| `readonly` | Read + status only; no writes, no containers |
| `supervised` | Full tool access; `require_approval_for` tools pause for confirmation |
| `full` | No confirmations; for trusted batch jobs only |

**Rationale**: A binary on/off is too coarse. Heartbeat runs checking container health should not be able to spin up new containers; a batch coding session may need full autonomy.

---

## ADR-010: Agent identity as markdown files

**Decision**: Agent identity is stored as `identity/IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md` — injected into the system prompt at session start via `transformContext`.

**Rationale**:
- Human-readable and directly editable without touching JSON
- The agent can update its own identity files during a session (e.g. `USER.md` when it learns something new)
- Each aspect is version-controllable independently

---

## ADR-011: pi-ai + pi-agent-core for LLM and agent loop

**Decision**: Use `@mariozechner/pi-ai` for multi-provider LLM abstraction and `@mariozechner/pi-agent-core` for the tool-calling agent loop. No custom ReAct implementation.

**Rationale**:
- pi-ai supports Anthropic, OpenAI, Google, Mistral, Groq, Ollama, OpenRouter etc. in one API — CloudMind is not locked to any provider
- pi-agent-core handles streaming, error recovery, context window management, and abort correctly — no need to reimplement
- `transformContext` callback is the natural hook for injecting working memory and identity
- pi-agent-core's events (`agent_start`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `error`) map 1:1 onto CloudMind's hook points

**Mitigation**: Isolate pi-agent-core behind a thin `AgentRunner` wrapper. If the dependency becomes untenable, only that class needs replacing.

---

## ADR-012: Channel system — HTTP API in agent process, external clients and bridge containers

**Decision**: The agent exposes an HTTP API (Hono) as its sole communication interface. There is no `ChannelManager`, no `Channel` TypeScript interface, and no channel code inside the agent process. The CLI is a thin external client program. Telegram is handled by a bridge service container the agent manages. Any language or platform can integrate by calling the HTTP API.

**HTTP API contract**:
- `POST /agents/{id}/messages` — accepts `InboundMessage` JSON (`{ sessionId, text, attachments? }`), returns `{ sessionId }`
- `GET /agents/{id}/events?sessionId=xxx` — SSE stream of `OutboundEvent` (`text_delta | text_final | tool_start | error`)
- Auth: bearer token generated at startup, stored at `runtime/api.token`, injected into bridge containers as `CLOUDMIND_API_KEY`
- Port: bound dynamically at startup (try `config.http_api.preferred_port` first; fall back to OS-assigned port `0`); actual port written to `runtime/api.port` — clients read it from there

**Rationale**:
- The agent process stays focused on its core job (LLM loop, tools, memory) — no platform-specific code inside
- Any language or platform can integrate by calling the HTTP API: no agent code changes needed to add a new channel
- The Telegram bridge runs as a service container the agent manages via `container_start` — this fits the existing "containers are tools" model perfectly; the agent already knows how to start, stop, and inject secrets into containers
- `host.docker.internal` is the standard Docker mechanism for containers calling the host; no extra networking configuration is required
- Adding a new channel means writing a container image (or any HTTP client), not modifying the agent
- Dynamic port binding means multiple agents can run on the same host with zero coordination — each agent writes its own port to `runtime/api.port`, clients read from there

**Key details**:
- Session IDs are namespaced by the client before the POST, enforced at the HTTP API boundary: `cli:{YYYY-MM-DD}-{nanoid}` (generated by the CLI), `telegram:{chat_id}` (generated by the bridge)
- Sessions from different clients share agent memory (`working.md`, `notes/`) but have separate conversation histories
- `config.channels.telegram_bridge.allowed_chat_ids` — allowlist enforced by the bridge container; empty list rejects all (safe default)
- The `runtime/` workspace directory is gitignored; both token and port are regenerated/rewritten on each agent startup
