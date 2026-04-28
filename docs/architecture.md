# Architecture

OpenHermit is a gateway-managed, multi-agent runtime. The gateway owns process lifecycle and API surface; each running agent is an in-process `AgentRunner` with its own workspace, security policy, tools, scheduler, channel adapters, MCP connections, and state scope.

## Components

```text
CLI / Web / Channels / API clients
          |
          v
Gateway (Hono HTTP + WebSocket, auth, admin UI)
          |
          v
AgentInstanceManager
          |
          +-- AgentRunner(agent A) -> exec backend -> workspace container/local shell
          +-- AgentRunner(agent B) -> exec backend -> workspace container/local shell
          |
          v
PostgreSQL stores (Drizzle)
```

| Component | Responsibility |
|-----------|----------------|
| `apps/gateway` | Control plane, auth, admin API, admin UI, agent lifecycle, WebSocket attachment, channel startup |
| `apps/agent` | Agent loop, prompt assembly, tools, sessions, events, introspection, compaction, scheduler, MCP client manager |
| `apps/cli` | Setup, gateway lifecycle, agent management, chat TUI, config/secrets, schedules, logs/status |
| `apps/web` | Standalone end-user chat web app |
| `apps/channels/*` | Telegram, Discord, and Slack bridges |
| `packages/protocol` | Shared contracts and route builders |
| `packages/sdk` | HTTP/SSE/WebSocket clients used by CLI/channels |
| `packages/store` | Drizzle schema and PostgreSQL store implementations |
| `packages/shared` | Errors, env loading, URL helpers, OpenHermit home helpers |

## State Boundary

OpenHermit keeps internal runtime state separate from external task state.

**Internal state** is owned by OpenHermit and stored in PostgreSQL unless noted:

- agent records
- sessions and session events
- working memory and session descriptions
- long-term memories
- instructions
- users, roles, identities, and merges
- container runtime inventory
- skills and skill assignments
- MCP server definitions and assignments
- schedules and schedule runs
- per-agent runtime config and security policy (`agents.config_json` / `agents.security_json` columns)
- per-agent secrets (encrypted in the `agent_secrets` table when `OPENHERMIT_SECRETS_KEY` is set; falls back to per-agent `secrets.json` only when no key is configured)
- channel rows with encrypted tokens (`agent_channels`)

**External state** is the user's work surface:

- workspace files
- generated artifacts
- project repositories
- mounted data under the workspace
- workspace-installed skills under `.openhermit/skills`

## Per-Agent State

Runtime config, security policy, and per-agent secrets are stored in PostgreSQL (`agents.config_json`, `agents.security_json`, `agent_secrets`) and managed through the admin UI, REST API, or `hermit config ... / hermit security ...`. Channels live in `agent_channels` with encrypted tokens, managed through `/api/agents/{agentId}/channels/...`. Secrets are encrypted at rest with `OPENHERMIT_SECRETS_KEY`; if no key is configured the gateway falls back to a plaintext `secrets.json` per agent (local-dev only — `hermit setup` enables the encrypted DB store).

Per-agent files under `~/.openhermit/agents/{agentId}/` are runtime/local state only:

```text
~/.openhermit/
├── agents/{agentId}/
│   └── skill-mounts/    # generated symlinks to enabled skills
└── workspaces/{agentId}/
```

`config_json` controls model, exec backend, web provider, and memory introspection. `security_json` controls autonomy level, approval policy, access level, and access token. Secrets are referenced from config values with `${{SECRET_NAME}}` and resolved through `SecretStore` at adapter-start time.

## Gateway Runtime

On startup, the gateway:

1. loads environment variables
2. loads `~/.openhermit/gateway.json`
3. opens PostgreSQL stores if `DATABASE_URL` is available
4. scans and registers built-in skills from `skills/`
5. starts the Hono server and WebSocket handler
6. auto-starts registered agents when `autoStartAgents` is true
7. syncs skill mount symlinks for each started agent

Each started agent initializes workspace/security, creates an `AgentRunner`, registers channel tokens, starts enabled built-in channels, starts the scheduler, and connects enabled MCP servers lazily through the runner.

## Agent Runtime

`AgentRunner` owns:

- durable session open/resume/list/delete behavior
- user and role resolution
- message queueing per session
- prompt assembly from instructions, memory, skills, user context, and recent history
- tool creation and role-based filtering
- tool approval pauses
- event persistence and realtime publication
- context compaction for long sessions
- introspection for memory and session metadata maintenance
- schedule execution host callbacks
- MCP tool discovery and namespacing
- channel outbound adapters for proactive `session_send`

The main model loop is backed by `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`.

## Execution Backends

The `exec` tool uses `ExecBackendManager`.

Supported backend types:

- `docker`: starts a per-agent workspace container through `DockerContainerManager`
- `local`: runs commands on the host in a configured working directory

If no exec config exists, the runner creates a local backend. Agent creation through the gateway writes a Docker backend by default.

Container lifecycle supports:

- start: `ondemand` or `session`
- stop: `idle` or `session`
- idle timeout in minutes

## Auth

Admin APIs require `GATEWAY_ADMIN_TOKEN`. Agent routes use a resolver that accepts:

- admin bearer token
- browser/device JWTs issued by `POST /api/auth/token` (user-global; the JWT identifies a person, not an agent)
- channel bearer tokens registered for built-in or external channel adapters

Agent access can be `public` or `protected`. Protected agents require the agent access token during device-token exchange.

## Extension Surfaces

- **Tools:** built-in toolsets plus dynamically connected MCP tools
- **Skills:** prompt instructions and supporting files, registered in DB and mounted read-only
- **Channels:** Telegram, Discord, Slack built-ins plus channel-token support for external adapters
- **Schedules:** cron/once jobs that post prompts into dedicated or configured sessions
- **Web providers:** Defuddle, Exa, Tavily

## Development Commands

```bash
npm run dev:gateway
npm run dev:web
npm run dev:cli
npm run dev:studio
npm run typecheck
npm test
```
