# OpenHermit

**Deploy, manage, and operate AI agents as production services.**

OpenHermit is a TypeScript multi-agent platform with a gateway control plane, durable PostgreSQL state, browser and CLI clients, built-in channel adapters, schedules, skills, MCP servers, and sandboxed execution backends.

![OpenHermit](docs/assets/openhermit.jpg)

## Current Shape

- **Gateway-managed agents.** `apps/gateway` owns agent records, starts/stops in-process `AgentRunner` instances, exposes `/agents/{agentId}/...`, serves the admin UI at `/admin/`, and auto-starts registered agents by default.
- **Durable internal state.** Sessions, events, memories, instructions, users, skills, MCP servers, schedules, and container inventory live in PostgreSQL through Drizzle-based stores in `packages/store`.
- **External workspace state.** User files and generated artifacts live in each agent workspace, usually mounted into a Docker exec backend at `/workspace`.
- **Multi-user access.** CLI, web, API, and channel identities resolve to users with `owner`, `user`, or `guest` roles. Owners can manage users, sessions, schedules, MCP servers, and skills through tools and the gateway UI/API.
- **Multiple transports.** The gateway supports JSON request/response, inline SSE streaming, durable SSE event streams, and WebSocket RPC/event subscriptions.
- **Built-in integrations.** Telegram, Discord, and Slack adapters can be enabled per agent; schedules support cron and one-shot jobs; MCP servers add external tools at runtime; skills add prompt-based procedures and supporting files.

## Repository Structure

```text
openhermit/
├── apps/
│   ├── agent/                # AgentRunner, tools, runtime, scheduler, channels
│   ├── gateway/              # Control plane, auth, admin API, admin UI
│   ├── cli/                  # Published `hermit` / `openhermit` CLI
│   ├── web/                  # End-user browser chat app
│   └── channels/
│       ├── telegram/         # Telegram adapter
│       ├── discord/          # Discord adapter
│       └── slack/            # Slack adapter
├── packages/
│   ├── protocol/             # Shared protocol types and route builders
│   ├── sdk/                  # HTTP/SSE/WebSocket clients
│   ├── shared/               # Common env, errors, URL helpers
│   └── store/                # Drizzle schema and PostgreSQL store implementations
├── skills/                   # Built-in OpenHermit skills registered by the gateway
└── docs/                     # Current architecture and operation docs
```

## Installation

```bash
npm install -g openhermit
```

This installs both `hermit` and `openhermit`.

For local development:

```bash
git clone https://github.com/williamwa/openhermit.git
cd openhermit
npm install
```

## Quick Start

```bash
# Configure DATABASE_URL, GATEWAY_ADMIN_TOKEN, and GATEWAY_JWT_SECRET.
hermit setup

# Start the gateway in the background.
hermit gateway start

# Check platform health.
hermit status
hermit doctor

# Create and start an agent if one does not already exist.
hermit agents create main
hermit agents start main

# Chat through the CLI.
hermit chat --agent-id main
```

The gateway defaults to `http://127.0.0.1:4000`. The admin UI is served by the gateway at `/admin/`. The separate end-user web app runs on `http://127.0.0.1:4310` when started with `npm run dev:web`.

## CLI Reference

| Area | Commands |
|------|----------|
| Setup | `hermit setup` |
| Gateway | `hermit gateway start`, `stop`, `run`, `status` |
| Agents | `hermit agents list`, `create`, `start`, `stop`, `restart`, `delete` |
| Chat | `hermit chat`, `hermit chat --agent-id <id>`, `hermit chat --resume`, `hermit chat --session <sessionId>` |
| Config | `hermit config show`, `get <key>`, `set <key> <value>` |
| Secrets | `hermit config secrets list`, `set <key> <value>`, `remove <key>` |
| Skills | `hermit skills list`, `assignments`, `scan`, `register`, `delete`, `enable`, `disable` |
| MCP | `hermit mcp list`, `assignments`, `enable`, `disable` |
| Schedules | `hermit schedules list`, `create`, `pause`, `resume`, `delete`, `runs` |
| Operations | `hermit status`, `hermit stats`, `hermit doctor`, `hermit logs [-f] [-n N]` |

Agent-scoped commands accept `--agent-id <id>` and default to `OPENHERMIT_AGENT_ID` or `main`.

## API Overview

Agent execution routes are exposed under `/api/agents/{agentId}`:

- `POST /api/agents/{id}/sessions`
- `GET /api/agents/{id}/sessions`
- `POST /api/agents/{id}/sessions/{sessionId}/messages`
- `POST /api/agents/{id}/sessions/{sessionId}/messages?wait=true`
- `POST /api/agents/{id}/sessions/{sessionId}/messages?stream=true`
- `GET /api/agents/{id}/sessions/{sessionId}/events`
- `POST /api/agents/{id}/sessions/{sessionId}/approve`
- `POST /api/agents/{id}/sessions/{sessionId}/checkpoint`
- `DELETE /api/agents/{id}/sessions/{sessionId}`
- `ws://host/api/agents/{id}/ws`

Admin and owner-facing management endpoints live under `/api/admin/...` and `/api/agents/{agentId}/...`. Channel webhooks land at `POST /api/agents/{id}/channels/{namespace}/webhook`. See [docs/transport-protocol.md](docs/transport-protocol.md), [docs/skills.md](docs/skills.md), [docs/mcp-servers.md](docs/mcp-servers.md), and [docs/channel-adapter.md](docs/channel-adapter.md).

## Internal State

All durable internal state is scoped by `agent_id` where applicable:

| Store | Contents |
|-------|----------|
| Agents | Registered agents, runtime config (`config_json`), security policy (`security_json`), workspace directories |
| Sessions | Metadata, status, participants, working memory, descriptions |
| Session events | User, assistant, tool, error, channel, and introspection events |
| Memories | Long-term memory with PostgreSQL FTS plus ILIKE fallback |
| Instructions | Agent identity, behavior, and rules included in prompts |
| Users | Users, identities, roles, and merge links |
| Containers | Workspace container inventory |
| Skills | Skill library and per-agent/global assignments |
| MCP servers | External MCP server definitions and assignments |
| Channels | Built-in and external channel rows with encrypted tokens |
| Secrets | Per-agent provider/integration secrets, encrypted at rest, referenced as `${{KEY}}` |
| Schedules | Cron/once jobs and run history |

Runtime config, security policy, and secrets are stored in PostgreSQL (secrets are encrypted with `OPENHERMIT_SECRETS_KEY`; without that key the gateway falls back to per-agent `secrets.json` for local dev). Per-agent files under `~/.openhermit/agents/{agentId}/` are local-only state: `runtime.json` (port + token written by the running agent) and `skill-mounts/` (generated symlinks to enabled skills).

## Development

```bash
npm run dev:gateway          # Gateway and admin UI API at http://127.0.0.1:4000
npm run dev:web              # End-user web app at http://127.0.0.1:4310
npm run dev:cli              # CLI from source
npm run dev:studio           # Drizzle Studio for the configured database
npm run typecheck            # Type-check all workspaces
npm test                     # Build and run test suites
```

Important environment variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_URL_TEST` | Test PostgreSQL connection string used by `npm test` |
| `GATEWAY_ADMIN_TOKEN` | Bearer token for admin APIs and CLI management |
| `GATEWAY_JWT_SECRET` | JWT signing secret for user/device tokens |
| `GATEWAY_PORT` / `PORT` | Gateway port, default `4000` |
| `OPENHERMIT_TOKEN` | CLI token, usually the admin token |
| `OPENHERMIT_GATEWAY_URL` | Gateway URL, default `http://127.0.0.1:4000` |
| `OPENHERMIT_AGENT_ID` | Default CLI agent ID, default `main` |
| `OPENHERMIT_WEB_PORT` | End-user web app port, default `4310` |

## Documentation

- [Architecture](docs/architecture.md)
- [Storage Model](docs/storage-model.md)
- [Session Model](docs/session-model.md)
- [User Model](docs/user-model.md)
- [Memory Model](docs/memory-model.md)
- [Sandbox Model](docs/sandbox-model.md)
- [Transport Protocol](docs/transport-protocol.md)
- [Tools](docs/tools.md)
- [Skills](docs/skills.md)
- [MCP Servers](docs/mcp-servers.md)
- [Channel Adapters](docs/channel-adapter.md)
- [Introspection Design](docs/introspection-design.md)
- [Architecture Decisions](docs/decisions.md)
- [Shipped Features](docs/plan.md)
- [Roadmap](docs/roadmap.md)
- [Open Questions](docs/pending-decisions.md)

## License

MIT
