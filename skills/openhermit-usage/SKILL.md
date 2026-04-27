---
name: openhermit-usage
description: Explain what OpenHermit is, how to set it up, use the CLI, configure agents, and interact via API or channels. Use when the user asks about OpenHermit itself.
---

# OpenHermit Usage Guide

Use this guide when explaining OpenHermit itself.

## What OpenHermit Is

OpenHermit is a TypeScript multi-agent platform with:

- gateway-managed agents
- PostgreSQL internal state through Drizzle stores
- CLI, admin UI, and end-user web app
- Telegram, Discord, and Slack channel adapters
- cron/once schedules
- prompt-based skills
- MCP server tool integrations
- Docker and local exec backends

The gateway manages agent lifecycle, auth, APIs, WebSocket/SSE transport, built-in channels, schedules, skills, and MCP assignments.

## Setup

```bash
npm install -g openhermit
hermit setup
hermit gateway start
hermit agents create main
hermit agents start main
hermit chat --agent-id main
```

`hermit setup` configures `.env`, can start local PostgreSQL through Docker Compose, applies Drizzle SQL migrations, and writes `OPENHERMIT_TOKEN` from the admin token for CLI use.

## Environment

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_URL_TEST` | Test database URL |
| `GATEWAY_ADMIN_TOKEN` | Admin bearer token |
| `GATEWAY_JWT_SECRET` | JWT signing secret |
| `OPENHERMIT_TOKEN` | CLI token, usually the admin token |
| `OPENHERMIT_GATEWAY_URL` | Gateway URL, default `http://127.0.0.1:4000` |
| `OPENHERMIT_AGENT_ID` | Default agent ID, default `main` |
| `OPENHERMIT_WEB_PORT` | End-user web app port, default `4310` |

## CLI

| Area | Commands |
|------|----------|
| Setup | `hermit setup` |
| Gateway | `hermit gateway start`, `stop`, `run`, `status` |
| Agents | `hermit agents list`, `create`, `start`, `stop`, `restart`, `delete` |
| Chat | `hermit chat`, `hermit chat --agent-id <id>`, `--resume`, `--session <id>` |
| Config | `hermit config show`, `get`, `set` |
| Secrets | `hermit config secrets list`, `set`, `remove` |
| Skills | `hermit skills list`, `assignments`, `scan`, `register`, `delete`, `enable`, `disable` |
| MCP | `hermit mcp list`, `assignments`, `enable`, `disable` |
| Schedules | `hermit schedules list`, `create`, `pause`, `resume`, `delete`, `runs` |
| Ops | `hermit status`, `hermit stats`, `hermit doctor`, `hermit logs` |

## Agent Config

Agent config and security policy are stored in PostgreSQL (`agents.config_json` / `agents.security_json`) and managed through the admin UI, REST API, or `hermit config ...` / `hermit security ...`. The shapes below describe the JSON value stored in those columns.

Model:

```json
{
  "model": {
    "provider": "openrouter",
    "model": "google/gemini-3-flash-preview",
    "max_tokens": 8192
  }
}
```

Exec:

```json
{
  "exec": {
    "backends": [
      { "type": "docker", "image": "ubuntu:24.04" },
      { "type": "local", "cwd": "/path/to/project" }
    ],
    "default_backend": "docker",
    "lifecycle": {
      "start": "ondemand",
      "stop": "idle",
      "idle_timeout_minutes": 30
    }
  }
}
```

Channels are not part of `config.json` — they live in the `agent_channels` table with encrypted tokens. Manage them via the admin UI, the `/api/agents/{agentId}/channels/...` routes, or `hermit channels ...`.

Provider/integration secrets are stored per-agent in `secrets.json` (file-backed via `SecretStore`). Set with `hermit config secrets set KEY value` and reference them in config values as `${{KEY}}`.

Security policy is the JSON in `agents.security_json`:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["exec"],
  "access": "protected",
  "access_token": "<token>"
}
```

## API

Core routes:

- `POST /agents/{id}/sessions`
- `GET /agents/{id}/sessions`
- `POST /agents/{id}/sessions/{sessionId}/messages`
- `POST /agents/{id}/sessions/{sessionId}/messages?wait=true`
- `POST /agents/{id}/sessions/{sessionId}/messages?stream=true`
- `GET /agents/{id}/sessions/{sessionId}/events`
- `ws://host/agents/{id}/ws`

Example:

```bash
curl -X POST 'http://127.0.0.1:4000/agents/main/sessions/cli%3Adefault/messages?wait=true' \
  -H "authorization: Bearer $OPENHERMIT_TOKEN" \
  -H "content-type: application/json" \
  -d '{"text":"Hello"}'
```

## Internal State

PostgreSQL stores agents, sessions, events, memories, instructions, users, containers, skills, MCP servers, schedules, and schedule runs.

Per-agent files contain config, security policy, secrets, and generated skill mounts. Workspace files are external task state, not conversation storage.

## Development

```bash
npm run dev:gateway
npm run dev:web
npm run dev:cli
npm run dev:studio
npm run typecheck
npm test
```
