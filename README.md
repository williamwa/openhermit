# OpenHermit

A container-native autonomous agent platform with persistent workspaces and memory, using Docker as the primary execution and service sandbox.

Like a hermit crab living inside its protective shell, an agent can use shells and containers as its sandbox: protected, autonomous, and able to operate safely while still interacting with the outside world. The system is designed for strong agent autonomy, sandboxed execution, and native multi-agent collaboration.

![OpenHermit](docs/assets/openhermit.jpg)

## Core Goals

- **Sandboxed Execution**: Code execution and long-running services run in isolated Docker containers controlled by the agent
- **Lifecycle Management**: Support both ephemeral (short-term) and persistent (long-term) agents
- **Memory System**: Pluggable memory provider with CRUD + search, episodic checkpoints, and session-local working memory
- **Context Hygiene**: Long sessions can compact older prompt history into runtime summaries while preserving recent turns
- **API-first**: All agent operations exposed via a clean HTTP + SSE API
- **Cloud-native**: Deployable on any VPS/cloud, orchestrated via Docker Compose or Kubernetes

## Why OpenHermit

OpenHermit is explicitly designed to address several structural issues that appear in OpenClaw-style systems:

1. **Safer execution by default**
   OpenClaw exposes a large amount of host power directly. OpenHermit treats sandboxing as a first-class design goal: the agent runs entirely inside containers, with code execution and long-running services isolated in their own sandboxes.

2. **Built for multi-user, multi-agent deployment from the start**
   OpenClaw is primarily optimized for self-hosting by a single operator. OpenHermit is designed from the beginning around multiple agents, multiple users, and future platform-style deployment. Its internal state model, runtime discovery, gateway control plane, and planned scheduler layer all aim toward hosted operation rather than only personal local use.

3. **Clear boundaries between components**
   OpenClaw concentrates many concerns into one large package. OpenHermit keeps the system split into focused components such as `agent`, `cli`, `web`, `gateway`, and shared protocol/sdk/store packages. Components are expected to communicate through explicit interfaces instead of hidden in-process coupling.

## State Layout

OpenHermit separates:

- `external state`: the agent workspace, containing user/project files the agent can operate on
- `internal state`: runtime-owned state stored outside the workspace under `~/.openhermit/{agent-id}/`

Current internal-state files include:

- `config.json`
- `runtime.json` while the agent is running
- `security.json`
- `secrets.json`

Structured runtime state (sessions, messages, memories, instructions, container inventory, users) is stored in a shared PostgreSQL database, scoped by `agent_id`. Schema is managed by Prisma migrations (`packages/store/prisma/`).

Agent identity and instructions are managed via the `InstructionStore` in PostgreSQL and updated through the `instruction_update` tool.
Runtime-owned settings such as model selection and checkpoint cadence live in `~/.openhermit/{agent-id}/config.json`.

## Repository Structure

```text
openhermit/
├── apps/
│   ├── agent/                # Single-agent runtime (Hono + session API)
│   ├── cli/                  # Platform CLI (hermit command)
│   ├── web/                  # Local browser client for the agent-local API
│   ├── gateway/              # Control plane for multi-agent lifecycle and proxy routing
│   └── channels/
│       └── telegram/         # Telegram channel adapter
├── packages/
│   ├── protocol/             # Shared session/event contracts and route constants
│   ├── sdk/                  # Gateway client SDK
│   ├── shared/               # Errors, runtime metadata types, small shared helpers
│   └── store/                # Store interfaces and Prisma/PostgreSQL adapters
└── docs/
    ├── architecture.md
    ├── participant-model.md
    ├── sandbox-model.md
    ├── storage-model.md
    ├── multi-agent-plan.md
    ├── plan.md
    ├── memory-model.md
    ├── session-model.md
    └── decisions.md
```

## Documentation

- Architecture: [docs/architecture.md](docs/architecture.md)
- Participant model (draft): [docs/participant-model.md](docs/participant-model.md)
- Sandbox model: [docs/sandbox-model.md](docs/sandbox-model.md)
- Storage model: [docs/storage-model.md](docs/storage-model.md)
- Multi-agent plan: [docs/multi-agent-plan.md](docs/multi-agent-plan.md)
- Plan: [docs/plan.md](docs/plan.md)
- Memory model: [docs/memory-model.md](docs/memory-model.md)
- Session model: [docs/session-model.md](docs/session-model.md)
- Decisions: [docs/decisions.md](docs/decisions.md)

## Installation

Install the CLI globally from npm:

```bash
npm install -g openhermit
```

This provides the `hermit` (and `openhermit`) command.

For development, clone the repo and use `tsx` directly:

```bash
git clone https://github.com/williamwa/openhermit.git
cd openhermit
npm install
```

## Quick Start

### 1. Run the setup wizard

```bash
hermit setup
```

This walks you through:
- Database setup (Docker Compose PostgreSQL, manual URL, or skip)
- Admin token generation
- JWT secret generation
- Writes everything to `.env`

### 2. Start the gateway

```bash
hermit gateway start     # background (logs to ~/.openhermit/gateway.log)
hermit gateway run       # foreground (for development)
```

### 3. Check platform status

```bash
hermit status            # gateway health + agent overview
hermit doctor            # verify environment (Node, Docker, config, connectivity)
```

### 4. Start chatting

```bash
hermit chat                          # interactive TUI chat
hermit chat --agent-id main          # target a specific agent
hermit chat --resume                 # resume the last session
hermit chat --session my-session     # use a named session
```

### 5. Manage agents

```bash
hermit agents list
hermit agents create my-agent
hermit agents start my-agent
hermit agents stop my-agent
hermit agents remove my-agent
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `hermit setup` | Interactive gateway setup wizard |
| `hermit chat` | Interactive TUI chat session |
| `hermit agents list\|create\|start\|stop\|remove` | Agent lifecycle management |
| `hermit gateway start\|stop\|run\|status` | Gateway daemon management |
| `hermit config show --agent-id <id>` | Show agent configuration |
| `hermit config get <key>` | Get a config value by dot-path |
| `hermit config set <key> <value>` | Set a config value by dot-path |
| `hermit config secrets list\|set\|remove` | Manage agent secrets |
| `hermit status` | Platform overview (gateway + agents) |
| `hermit doctor` | Environment health checks |
| `hermit logs` | View gateway logs (`-f` to follow, `-n` for count) |

## Development

```bash
# Start the gateway in development mode (foreground with hot reload)
npm run dev:gateway

# Start the CLI in development mode
npm run dev:cli

# Start the web UI
npm run dev:web          # then open http://127.0.0.1:4310

# Start the standalone agent runtime (without gateway)
npm run dev:agent
npm run dev:agent -- --agent-id main
```

### Environment

The CLI auto-loads `.env` from the current directory on startup. Key variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `GATEWAY_ADMIN_TOKEN` | Admin token for gateway API |
| `GATEWAY_JWT_SECRET` | JWT signing secret |
| `OPENHERMIT_TOKEN` | CLI authentication token (defaults to admin token) |
| `OPENHERMIT_GATEWAY_URL` | Gateway URL (default: `http://127.0.0.1:4000`) |
| `OPENHERMIT_AGENT_ID` | Default agent ID (default: `main`) |

Optional: to emit Langfuse traces, add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and optionally `LANGFUSE_BASE_URL` to your `.env`.
