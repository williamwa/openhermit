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
- `state.sqlite`
- `runtime.json` while the agent is running
- `security.json`
- `secrets.json`

Agent identity and instructions are managed via the `InstructionStore` in PostgreSQL and updated through the `instruction_update` tool.
Runtime-owned settings such as model selection and checkpoint cadence live in `~/.openhermit/{agent-id}/config.json`.

`state.sqlite` now stores sessions, session history, memories, instructions, and container runtime inventory. It also uses lightweight versioned migrations for incremental schema changes.

## Repository Structure

```text
openhermit/
├── apps/
│   ├── agent/                # Single-agent runtime (Hono + session API)
│   ├── cli/                  # Local terminal client for the agent-local API
│   ├── web/                  # Local browser client and launcher for the agent-local API
│   ├── gateway/              # Control plane for multi-agent lifecycle and proxy routing
│   └── channels/
│       └── telegram/         # Future IM bridge example
├── packages/
│   ├── protocol/             # Shared session/event contracts and route constants
│   ├── sdk/                  # Thin client for agent-local API calls
│   ├── shared/               # Errors, runtime metadata types, small shared helpers
│   └── store/                # Store interfaces (SessionStore, MemoryProvider, etc.) and SQLite adapters
└── docs/
    ├── architecture.md
    ├── participant-model.md   # Draft participant / role model
    ├── sandbox-model.md       # Sandbox model (ephemeral, service, workspace, daily)
    ├── storage-model.md       # Storage abstraction model
    ├── multi-agent-plan.md    # Multi-agent, store, plugin architecture plan
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

## Quick Start

1. Add your model API key to `~/.openhermit/main/secrets.json`, for example:

```json
{
  "ANTHROPIC_API_KEY": "your-key"
}
```

Optional: to emit Langfuse traces for model requests, add `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and optionally `LANGFUSE_BASE_URL` to [`apps/agent/.env`](apps/agent/.env). The agent entrypoint loads that file automatically on startup.

2. Start the agent:

```bash
npm run dev:agent
npm run dev:agent -- --agent-id main
```

`dev:agent` runs in watch mode and restarts automatically when agent source files change.
It also accepts `--agent-id` and `--port`.

3. In another terminal, start the minimal CLI:

```bash
npm run chat:agent
```

`chat:agent` and `dev:cli` both start the interactive CLI directly. The CLI is intentionally not run under watch mode because file-watch wrappers interfere with terminal input handling.

CLI options:

```bash
npm run chat:agent -- --agent-id main
npm run chat:agent -- --session cli:resume-me
npm run chat:agent -- --resume
```

The CLI discovers the running agent via:

- `~/.openhermit/{agent-id}/runtime.json`

That `runtime.json` is now treated as live runtime metadata:

- normal agent shutdown removes it
- agent startup refuses to continue if the file already exists
- if startup finds a stale file, it reports that explicitly instead of silently overwriting it

4. Or start the local web UI:

```bash
npm run dev:web
```

Then open [http://127.0.0.1:4310](http://127.0.0.1:4310).

The current web app is a minimal static frontend served from `apps/web/public/`.
It no longer accepts `--agent-id` or `--workspace`; only the port is configurable:

```bash
OPENHERMIT_WEB_PORT=4310 npm run dev:web
PORT=4310 npm run dev:web
```

5. Or start the multi-agent gateway:

```bash
npm run dev:gateway
```

Then point the CLI at the gateway (default: `http://127.0.0.1:4000`). The current CLI talks to the gateway first, then selects an agent via `/agents/{agentId}/...`.

If `tsx` is not suitable in your environment, you can build first and run the compiled entrypoints from `apps/agent/dist/`, `apps/cli/dist/`, and `apps/web/dist/`.
