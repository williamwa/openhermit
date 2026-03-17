# OpenHermit

A host-based autonomous agent platform with persistent workspaces and memory, using Docker as an isolated execution and service sandbox.

Like a hermit crab living inside its protective shell, an agent can use shells and containers as its sandbox: protected, autonomous, and able to operate safely while still interacting with the outside world. The system is designed for strong agent autonomy, sandboxed execution, and native multi-agent collaboration.

![OpenHermit](docs/assets/openhermit.jpg)

## Core Goals

- **Sandboxed Execution**: Code execution and long-running services run in isolated Docker containers controlled by the agent
- **Lifecycle Management**: Support both ephemeral (short-term) and persistent (long-term) agents
- **Memory System**: Multi-layer memory — session state, episodic checkpoints, and named memories like `main` and `now`
- **Context Hygiene**: Long sessions can compact older prompt history into runtime summaries while preserving recent turns
- **API-first**: All agent operations exposed via a clean HTTP + SSE API
- **Cloud-native**: Deployable on any VPS/cloud, orchestrated via Docker Compose or Kubernetes

## Why OpenHermit

OpenHermit is explicitly designed to address several structural issues that appear in OpenClaw-style systems:

1. **Safer execution by default**
   OpenClaw exposes a large amount of host power directly. OpenHermit treats sandboxing as a first-class design goal: code execution and long-running services are pushed into isolated containers so the agent can stay powerful without defaulting to host-level trust.

2. **Built for multi-user, multi-agent deployment from the start**
   OpenClaw is primarily optimized for self-hosting by a single operator. OpenHermit is designed from the beginning around multiple agents, multiple users, and future platform-style deployment. Its internal state model, runtime discovery, and planned scheduler/gateway layers all aim toward hosted operation rather than only personal local use.

3. **Clear boundaries between components**
   OpenClaw concentrates many concerns into one large package. OpenHermit keeps the system split into focused components such as `agent`, `cli`, `web`, future `gateway`, and shared protocol/sdk packages. Components are expected to communicate through explicit interfaces instead of hidden in-process coupling.

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

The workspace now keeps agent-managed external inputs under `workspace/.openhermit/`, including identity markdown and workspace-level integration config.
Runtime-owned settings such as model selection and checkpoint cadence live in `~/.openhermit/{agent-id}/config.json`.

`state.sqlite` now stores sessions, session history, named memories, and container runtime inventory. It also uses lightweight versioned migrations for incremental schema changes.

## Repository Structure

```text
openhermit/
├── apps/
│   ├── agent/                # Current focus: single-agent runtime (Hono + session API)
│   ├── cli/                  # Local terminal client for the agent-local API
│   ├── web/                  # Local browser client and launcher for the agent-local API
│   ├── gateway/              # Future control plane for multi-agent management
│   └── channels/
│       └── telegram/         # Future IM bridge example
├── packages/
│   ├── protocol/             # Shared session/event contracts and route constants
│   ├── sdk/                  # Thin client for agent-local API calls
│   └── shared/               # Errors, runtime metadata types, small shared helpers
└── docs/
    ├── architecture.md
    ├── plan.md
    ├── memory-model.md
    ├── session-model.md
    └── decisions.md
```

## Documentation

- Architecture: [docs/architecture.md](docs/architecture.md)
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
It also accepts `--agent-id`, `--workspace`, `--name`, and `--port`.

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

4. Or start the local web client:

```bash
npm run dev:web
```

Then open [http://127.0.0.1:4310](http://127.0.0.1:4310).

Web options:

```bash
npm run dev:web -- --agent-id main
npm run dev:web -- --workspace /absolute/path/to/workspace
npm run dev:web -- --port 4310
```

The web launcher also reads:

- `~/.openhermit/{agent-id}/runtime.json`

If `tsx` is not suitable in your environment, you can build first and run the compiled entrypoints from `apps/agent/dist/`, `apps/cli/dist/`, and `apps/web/dist/`.
