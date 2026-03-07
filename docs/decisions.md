# Architecture Decision Records (ADR)

These ADRs include both v0.1 decisions and deferred future direction.

For implementation scope, `README.md`, `docs/architecture.md`, and `docs/plan.md` define the current v0.1 contract. If an ADR discusses a feature outside that contract, treat it as deferred work rather than current scope.

---

## ADR-001: Agent runs on host, containers are tools

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: The agent process runs directly on the host machine. Docker containers are not the agent — they are tools the agent uses to run code and services.

**Reasons**:
- Agent needs persistent state and memory that survives container restarts
- Agent needs to manage Docker itself (requires Docker socket access, awkward if inside Docker)
- Simpler mental model: agent = process, containers = workers the agent dispatches to
- Easier to debug (agent logs are on the host, not inside a container)

**Trade-offs**:
- Agent process must be kept alive on the host (pm2 / systemd)
- Node.js must be installed on the host (not containerized)
- Agent has access to host filesystem — enforced isolation is workspace boundary, not OS-level

---

## ADR-002: File-based memory (Markdown + JSONL), no database in v1

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: All memory and session data stored as plain files. No database dependency in v1.

| Data | Format | Rationale |
|------|--------|-----------|
| Working memory | Markdown (`.md`) | Human-readable, LLM-friendly, easy to inspect/edit |
| Long-term notes | Markdown (`.md`) | One file per topic, easy to browse, agent writes directly |
| Episodic log | JSONL (`.jsonl`) | Append-only, structured, trivially parseable |
| Session history | JSONL (`.jsonl`) | Structured, append-only, one file per session |
| Container registry | JSONL (`.jsonl`) | Append-only audit log + easy to tail/grep |
| Agent config | JSON (`.json`) | Single structured config, rarely written |

**Reasons**:
- Zero infrastructure dependencies (no Postgres, Redis, SQLite to set up)
- Files are directly readable by both human and LLM
- JSONL is trivially appendable and grep-able
- Easy to back up (just zip the workspace directory)
- Agent can directly read/write its own memory files as a tool call

**Upgrade path**: Migrate episodic.jsonl and sessions to SQLite in a later phase when query performance becomes a bottleneck. The file schema maps directly to SQLite tables.

---

## ADR-003: One workspace per agent, strict boundary enforcement

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: Each agent has one root workspace directory. All reads and writes must be within this directory. Container mounts only point into `workspace/containers/{name}/data/`.

**Enforcement**:
- `workspace.resolve(path)` throws if the resolved path escapes workspace root
- Container mount source is always validated before passing to Docker
- Agent tools (`read_file`, `write_file`) go through `workspace.resolve()`

**Reasons**:
- Prevents agents from accidentally (or intentionally) modifying unrelated parts of the host
- Makes backup/restore trivial (one directory = one agent)
- Clear audit surface: anything the agent did is visible in its workspace

---

## ADR-004: Two container types — ephemeral and service

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: Distinguish between ephemeral containers (run → output → removed) and service containers (long-running, port-bound, persisted).

| Aspect | Ephemeral | Service |
|--------|-----------|---------|
| Lifetime | Single command | Until stopped |
| Auto-remove | Yes (`--rm`) | No |
| Port bindings | No | Yes |
| Mount persisted | No | Yes |
| In registry | Yes (for audit) | Yes (active record) |
| Restart policy | None | `unless-stopped` |

**Reasons**:
- Different use cases have fundamentally different lifecycle needs
- Ephemeral containers are cheap — no cleanup burden, no state to manage
- Service containers need monitoring, port management, and restart handling

---

## ADR-005: Agent cannot run privileged host commands (except Tailscale Funnel)

**Date**: 2026-03-07
**Status**: Updated 2026-03-07

**Decision**: The agent process does not have (and does not request) sudo access. One exception: `tailscale funnel` is a non-privileged user command and the agent can run it directly via the `tailscale_funnel` tool. UFW/iptables changes still require the user.

**Reasons**:
- Principle of least privilege
- `tailscale funnel` does not require root — it communicates with the local Tailscale daemon via Unix socket, available to any user in the `tailscale` group or the socket owner
- Having the agent manage funnel state directly makes service container workflows much smoother

**Implications**:
- UFW/iptables changes still must be done by the user if needed
- Agent tracks which ports are funneled in `config.port_registry.funneled`

---

## ADR-006: TypeScript as primary runtime language

**Date**: 2026-03-07
**Status**: Updated 2026-03-07

**Decision**: Node.js TypeScript for the entire agent runtime (workspace module, security module, container manager, tool handlers, CLI). No change — TypeScript remains the host-side language.

**Reasons**:
- Single language for the whole agent runtime
- Strong typing makes tool schema generation and path validation straightforward
- Large async/stream ecosystem (Dockerode, streaming events)
- pi-ai and pi-agent-core are TypeScript-native packages

**Container workloads** can use any language — the agent just exec's into Docker.

**Note**: LLM provider abstraction is handled by pi-ai (see ADR-011), not the Anthropic SDK directly.

---

## ADR-007: Security config stored outside workspace (scope: autonomy policy only)

**Date**: 2026-03-07
**Status**: Updated 2026-03-07

**Decision**: A slim security config lives at `~/.cloudmind/{agent-id}/security.json`, outside the workspace. It contains only two fields: `autonomy_level` and `require_approval_for`.

**What it does NOT contain** (and why):
- **`forbidden_paths`** — redundant. Three-layer path validation is hardcoded into the workspace module; the agent physically cannot reach host paths like `/etc` or `~/.ssh` regardless of configuration. A list of forbidden paths would be security theatre.
- **`allowed_commands`** — not a security boundary. Commands run *inside Docker containers* which only have access to their mounted `containers/{name}/data/` subdirectory. A container running `rm -rf /` destroys only the container. Moved to `config.json` as an operational preference.

**What stays here and why**:
- `autonomy_level` — if stored inside the workspace, the agent could use `write_file` to escalate itself from `supervised` to `full`, bypassing all approval gates.
- `require_approval_for` — same reasoning: an agent that can remove items from this list can silently remove its own approval requirements.

**File**:
```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["container_start", "tailscale_funnel"]
}
```

**Trade-offs**:
- Two config locations (workspace `config.json` for everything operational; `~/.cloudmind/{agent-id}/` for autonomy policy)
- User must know to edit `~/.cloudmind/{agent-id}/` to change autonomy settings

---

## ADR-008: Three-layer path validation

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: All file paths go through three checks: null byte detection → workspace boundary check → symlink escape check via `realpathSync`.

**Reason**: Each layer catches a different class of attack:
- Null bytes: `path.includes('\0')` — some systems truncate at null, allowing path confusion
- Boundary: simple `startsWith(workspaceRoot)` — catches `../../../etc/passwd` style traversal
- Symlink: `realpathSync` then re-check — catches symlinks inside workspace pointing outside

Two layers (without symlink) would still be exploitable via a symlink. All three are needed.

---

## ADR-009: Autonomy levels (readonly / supervised / full)

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: Agent operates at one of three autonomy levels configured in the security file. Heartbeat sessions always use `readonly` or `supervised`, never `full`.

**Reason**: Different contexts need different trust levels. A heartbeat run checking container health should not be able to spin up new containers. A user-initiated coding session needs write access. A trusted batch job can run fully autonomously. One binary setting (on/off) is too coarse.

**Default**: `supervised` — tools work freely, but `require_approval_for` list items pause for user confirmation.

---

## ADR-010: Agent identity as markdown files, not system prompt string

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: Agent identity is stored as `identity/IDENTITY.md`, `SOUL.md`, `USER.md`, `AGENTS.md` — loaded at session start and injected into the system prompt. Not a single `system_prompt` string in config.json.

**Reason**:
- Markdown files are human-readable and directly editable by the user without touching JSON
- The agent itself can read and update its identity files as part of a session (e.g., updating USER.md when it learns something new about the user)
- Easier to version-control individual identity aspects independently
- Follows the convention established by OpenClaw and its derivatives — portable format

---

## ADR-012: Security config scope — autonomy policy only, not path/command blocking

**Date**: 2026-03-07
**Status**: Accepted

**Context**: Initial design included `forbidden_paths` and `allowed_commands` in the security config alongside `autonomy_level` and `require_approval_for`. On review, the first two are redundant given the system architecture.

**Decision**: The `~/.cloudmind/{agent-id}/security.json` file contains only:
1. `autonomy_level` — controls whether the agent needs user approval to act
2. `require_approval_for` — list of specific tools that always require confirmation

`forbidden_paths` and `allowed_commands` are dropped entirely.

**Reasoning**:

*`forbidden_paths` is redundant*: Three-layer path validation (null byte + workspace boundary + symlink escape via `realpathSync`) is hardcoded in the workspace module. The agent cannot reach any host path outside its workspace regardless of configuration. Maintaining a shadow list of blocked system directories (`/etc`, `~/.ssh`, etc.) alongside an already-enforced structural boundary is security theatre — it adds complexity without adding protection.

*`allowed_commands` is not a security boundary*: Commands passed to `container_exec` / `container_run` run inside Docker containers which only have access to the agent's own `containers/{name}/data/` subdirectory. The host filesystem is not in scope for container processes. A command whitelist would restrict agent expressiveness without protecting anything the architecture doesn't already protect. Operational command preferences (e.g. "only run these tools in heartbeat mode") belong in `config.json` as policy, not in the tamper-resistant security file.

**Why `autonomy_level` and `require_approval_for` must stay outside workspace**: These directly govern whether the agent can act without human confirmation. An agent with `write_file` access to its workspace could otherwise promote its own autonomy level or remove tools from its approval list, effectively disabling its own oversight mechanism.

---

## ADR-013: Secrets stored outside workspace, values never exposed to LLM

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: Sensitive credentials (API keys, bot tokens, database passwords) are stored in `~/.cloudmind/{agent-id}/secrets.json`, outside the workspace. The LLM sees only the key names, never the values. Values are injected directly into container environment variables at runtime.

**Credential flow**:
```
secrets.json → agent process memory → Docker --env flag → container process
                                    ↑
                           LLM only sees key names here
                           (never the values)
```

**Why not `config.json` inside the workspace**:
The agent has `read_file` access to its workspace. If secrets lived in `config.json`, the LLM could call `read_file("config.json")` and receive all credential values in its context window — from where they could leak into logs, summaries, notes, or session files. Keeping secrets outside the workspace makes this structurally impossible.

**Why the LLM gets key names but not values**:
- The LLM needs to know *which* secrets exist so it can request them by name in tool calls (e.g. `env_secrets: ["OPENAI_API_KEY"]`)
- The LLM does not need the actual value — it just needs to instruct the agent process to inject it
- Key names are low-sensitivity (they describe what the secret is, not the secret itself)

**How secrets reach containers**:
- Tool definitions that accept `env_secrets: string[]` resolve each name to its value from the in-memory secrets map
- The resolved value is passed as a Docker `--env` flag — it never appears in the tool result returned to the LLM
- Tool result says: `"env vars set: OPENAI_API_KEY"` — confirming injection without echoing the value

**Format**: `~/.cloudmind/{agent-id}/secrets.json`
```json
{
  "OPENAI_API_KEY": "sk-...",
  "DISCORD_BOT_TOKEN": "...",
  "DATABASE_PASSWORD": "...",
  "GITHUB_TOKEN": "ghp_..."
}
```

**Trade-offs**:
- Secrets are flat key→value, no namespacing or per-container scoping in v1
- Agent process holds secrets in memory for the session lifetime (acceptable for a single-user local process)
- User must manage this file manually (no secret rotation or vault integration in v1)

---

## ADR-011: Use pi-ai + pi-agent-core instead of Anthropic SDK + custom ReAct loop

**Date**: 2026-03-07
**Status**: Accepted

**Decision**: Use `@mariozechner/pi-ai` for multi-provider LLM abstraction and `@mariozechner/pi-agent-core` for the stateful tool-calling agent loop. Do not build a custom ReAct loop or use the Anthropic SDK directly.

**Packages**:
- `@mariozechner/pi-ai` — unified API for Anthropic, OpenAI, Google Gemini, Mistral, Groq, Bedrock, Ollama, OpenRouter, etc. TypeBox-based tool schemas. Built-in cost/usage tracking.
- `@mariozechner/pi-agent-core` — stateful `Agent` class with multi-turn tool-calling loop, streaming events, `transformContext` callback, `agent.setModel()`, `agent.abort()`.

**Reasons**:
1. **Multi-provider requirement**: CloudMind must not be locked to Claude. pi-ai provides a single unified interface for all major providers. Switching models is one config change.
2. **Avoid custom loop complexity**: A correct, robust ReAct loop (streaming, error recovery, context window management, abort) is non-trivial to build and maintain. pi-agent-core already solves this.
3. **`transformContext` is a natural fit**: The callback fires before each LLM call — the ideal place to inject fresh working memory, identity files, and note filenames without reimplementing context assembly.
4. **Event system maps cleanly to hook system**: pi-agent-core emits `agent_start`, `tool_execution_start`, `tool_execution_end`, `agent_end`, `error` — a 1:1 mapping onto CloudMind's `onSessionStart`, `beforeToolCall`, `afterToolCall`, `onSessionEnd`, `onError` hooks.
5. **Runtime model switching**: `agent.setModel(modelString)` enables the `cloudmind model set` CLI command without restarting the process.

**Trade-offs**:
- External dependency on `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (private packages from `badlogic/pi-mono`)
- Less control over internal loop behaviour vs. a custom implementation
- If pi-agent-core has a breaking change, CloudMind is affected

**Mitigation**: Isolate pi-agent-core usage behind a thin `AgentRunner` wrapper class. If the dependency becomes untenable, only that class needs to be replaced.
