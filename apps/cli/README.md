# OpenHermit CLI

The `openhermit` package publishes the `hermit` and `openhermit` commands. The CLI configures the gateway, manages agents, opens TUI chat sessions, edits agent config/secrets, manages schedules, and reads operational status/logs.

## Install

```bash
npm install -g openhermit
```

For repository development:

```bash
npm install
npm run dev:cli -- --help
```

## Common Flow

```bash
hermit setup
hermit gateway start
hermit agents create main
hermit agents start main
hermit chat --agent main
```

`hermit setup` writes `.env`, can start the local Docker Compose PostgreSQL service, applies Drizzle migrations from `packages/store/drizzle`, and sets `OPENHERMIT_TOKEN` to the admin token for CLI convenience.

## Commands

| Area | Commands |
|------|----------|
| Setup | `hermit setup` |
| Gateway | `hermit gateway start`, `stop`, `run`, `status` |
| Agents | `hermit agents list`, `create <agentId> [--name] [--workspace-dir] [--owner]`, `start`, `stop`, `restart`, `delete` |
| Chat | `hermit chat [--agent <id>] [--resume] [--session <sessionId>]` |
| Config | `hermit config show`, `get <key>`, `set <key> <value>` |
| Secrets | `hermit config secrets list`, `set <key> <value>`, `remove <key>` |
| Skills | `hermit skills list`, `assignments`, `scan`, `register <id> --name --description --path`, `delete <id>`, `enable <id> --agent <id>`, `disable <id> --agent <id>` |
| MCP | `hermit mcp list`, `assignments`, `enable <id> --agent <id>`, `disable <id> --agent <id>` |
| Schedules | `hermit schedules list [--status]`, `create --prompt ... [--cron ... | --run-at ...]`, `pause`, `resume`, `delete`, `runs` |
| Operations | `hermit status`, `hermit stats`, `hermit doctor`, `hermit logs [-f] [-n N] [--json]` |

Agent-scoped commands default to `OPENHERMIT_AGENT_ID` or `main`.

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_URL_TEST` | Test database URL used by the repository test script |
| `GATEWAY_ADMIN_TOKEN` | Bearer token for admin APIs and CLI management |
| `GATEWAY_JWT_SECRET` | JWT signing secret for browser/device auth |
| `OPENHERMIT_TOKEN` | CLI bearer token, usually the admin token |
| `OPENHERMIT_GATEWAY_URL` | Gateway URL, default `http://127.0.0.1:4000` |
| `OPENHERMIT_AGENT_ID` | Default agent ID, default `main` |

## Package Contents

The published package bundles the CLI, gateway entrypoint, and built static UI assets copied from the gateway admin UI and end-user web app during `prepublishOnly`.

See the repository [README](../../README.md) and [docs](../../docs/architecture.md) for the platform architecture.
