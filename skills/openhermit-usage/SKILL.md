---
name: openhermit-usage
description: Explain what OpenHermit is, how to set it up, use the CLI, configure agents, and interact via API or channels. Use when the user asks about OpenHermit itself.
---

# OpenHermit Usage Guide

You are an OpenHermit agent. When users ask about OpenHermit — what it is, how to use it, how to configure things — use this guide.

## What is OpenHermit

OpenHermit is a multi-agent platform for deploying and managing autonomous AI agents as production services. Key properties:

- **Platform-first**: A central gateway manages many agents on shared infrastructure with a shared PostgreSQL database.
- **Multi-user**: Multiple users interact with each agent via CLI, web, or channel adapters (Telegram, etc.). Users are identified and tracked with role-based access (owner / user / guest).
- **Sandboxed**: Each agent runs code inside its own Docker workspace container, isolating actions from the host.
- **Centralized state**: Sessions, memories, instructions, and user data live in PostgreSQL — not in per-agent files.

## Architecture

```
Gateway (control plane)
  ├── Agent A ─── Container A
  ├── Agent B ─── Container B
  └── Agent C ─── Container C

PostgreSQL (shared state store)
```

The gateway manages agent lifecycle, routing, and auth. Each agent has an in-process runtime and a Docker workspace container.

## Setup

```bash
# Install
npm install -g openhermit

# Interactive setup (database, admin token, JWT secret)
hermit setup

# Start the gateway
hermit gateway start

# Verify
hermit status
hermit doctor
```

### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `GATEWAY_ADMIN_TOKEN` | Admin token for gateway API |
| `GATEWAY_JWT_SECRET` | JWT signing secret |

Optional:
| Variable | Description |
|----------|-------------|
| `OPENHERMIT_TOKEN` | CLI auth token (defaults to admin token) |
| `OPENHERMIT_GATEWAY_URL` | Gateway URL (default: `http://127.0.0.1:4000`) |
| `OPENHERMIT_AGENT_ID` | Default agent ID (default: `main`) |

## CLI Commands

### Platform Management

| Command | What it does |
|---------|-------------|
| `hermit setup` | Interactive setup wizard |
| `hermit gateway start` | Start gateway as daemon |
| `hermit gateway stop` | Stop gateway daemon |
| `hermit gateway run` | Run gateway in foreground |
| `hermit status` | Gateway health + agent list |
| `hermit doctor` | Environment health checks |
| `hermit logs [-f] [-n N]` | View gateway logs |

### Agent Management

| Command | What it does |
|---------|-------------|
| `hermit agents list` | List all agents |
| `hermit agents create <id>` | Create a new agent |
| `hermit agents start <id>` | Start an agent |
| `hermit agents stop <id>` | Stop a running agent |
| `hermit agents remove <id>` | Remove a stopped agent |

### Chat

| Command | What it does |
|---------|-------------|
| `hermit chat` | Interactive TUI chat |
| `hermit chat --agent-id <id>` | Chat with a specific agent |
| `hermit chat --resume` | Resume last session |
| `hermit chat --session <name>` | Use a named session |

### Configuration

| Command | What it does |
|---------|-------------|
| `hermit config show` | Show full agent config |
| `hermit config get <key>` | Get value by dot-path (`model.provider`) |
| `hermit config set <key> <value>` | Set value by dot-path |
| `hermit config secrets list` | List secrets (masked) |
| `hermit config secrets set <key> <value>` | Set a secret |
| `hermit config secrets remove <key>` | Remove a secret |

All agent commands accept `--agent-id <id>` (default: `main` or `$OPENHERMIT_AGENT_ID`).

## Agent Configuration

Agent config is stored at `~/.openhermit/agents/<agentId>/config.json`. Key sections:

### Model

```json
{
  "model": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-20250514",
    "max_tokens": 8192
  }
}
```

Set API keys as secrets: `hermit config secrets set ANTHROPIC_API_KEY <key>`

### Execution Backend

Agents can execute commands via Docker (default) or local shell:

```json
{
  "exec": {
    "backends": [
      { "type": "docker", "image": "node:20" },
      { "type": "local", "cwd": "/path/to/project" }
    ],
    "default_backend": "docker"
  }
}
```

### Channels

Enable Telegram:
```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "bot_token": "<bot-token-from-botfather>"
    }
  }
}
```

### Security Policy

```json
{
  "security": {
    "autonomy_level": "supervised",
    "require_approval_for": [],
    "access": "protected",
    "access_token": "<token>"
  }
}
```

Autonomy levels: `readonly` (observe only), `supervised` (ask before risky actions), `full` (autonomous).

## API

The gateway exposes a multi-protocol API:

- **HTTP sync**: `POST /agents/{id}/sessions/{sid}/messages?wait=true`
- **HTTP streaming**: `POST /agents/{id}/sessions/{sid}/messages?stream=true` (SSE)
- **WebSocket**: `ws://host/agents/{id}/ws` (bidirectional RPC)

### Common Patterns

```bash
# Send a message and wait for response
curl -X POST http://localhost:4000/agents/main/sessions/my-session/messages?wait=true \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"text": "Hello, what can you do?"}'

# List sessions
curl http://localhost:4000/agents/main/sessions \
  -H "Authorization: Bearer <token>"
```

## Skills

Skills are prompt-based instructions that extend agent capabilities. They are loaded at startup and shown in the system prompt index.

- **Platform skills**: Admin-managed, mounted read-only at `/skills/<id>/`
- **Per-agent skills**: Owner-managed, enabled per agent
- **Workspace skills**: Agent-installed at `/workspace/.openhermit/skills/<id>/`

Read a skill: `cat /skills/<skill-id>/SKILL.md`

## Internal State

All internal state is in PostgreSQL, scoped by `agent_id`:

| Store | Contents |
|-------|----------|
| Sessions | Metadata, execution state, compaction summaries |
| Messages | Full session history |
| Memories | Long-term memory with full-text search |
| Instructions | Agent identity and behavior instructions |
| Users | Identities, roles, cross-identity linking |
| Containers | Workspace container inventory |

Per-agent local files (`~/.openhermit/agents/<agentId>/`) hold only runtime config, secrets, and security policy — not conversation data.

## Development

```bash
npm run dev:gateway    # Gateway with hot reload
npm run dev:cli        # CLI
npm run dev:web        # Web UI at http://127.0.0.1:4310
npm run dev:agent      # Standalone agent (no gateway)
```
