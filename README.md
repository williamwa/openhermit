# OpenHermit

A host-based autonomous agent platform with persistent workspaces and memory, using Docker as an isolated execution and service sandbox.

Like a hermit crab living inside its protective shell, an agent can use shells and containers as its sandbox: protected, autonomous, and able to operate safely while still interacting with the outside world. The system is designed for strong agent autonomy, sandboxed execution, and native multi-agent collaboration.

## Core Goals

- **Sandboxed Execution**: Code execution and long-running services run in isolated Docker containers controlled by the agent
- **Lifecycle Management**: Support both ephemeral (short-term) and persistent (long-term) agents
- **Memory System**: Multi-layer memory — working memory, episodic memory, long-term knowledge
- **API-first**: All agent operations exposed via a clean HTTP + SSE API
- **Cloud-native**: Deployable on any VPS/cloud, orchestrated via Docker Compose or Kubernetes

## Repository Structure

```text
openhermit/
├── apps/
│   ├── agent/                # Current focus: single-agent runtime (Hono + session API)
│   ├── cli/                  # Local terminal client for the agent-local API
│   ├── gateway/              # Future control plane for multi-agent management
│   └── channels/
│       └── telegram/         # Future IM bridge example
├── packages/
│   ├── protocol/             # Shared session/event contracts and route constants
│   ├── sdk/                  # Thin client for agent-local API calls
│   └── shared/               # Errors, runtime file constants, small shared helpers
└── docs/                     # Architecture, planning, ADRs
```

## Quick Start

1. Add your model API key to `~/.openhermit/agent-dev/secrets.json`, for example:

```json
{
  "ANTHROPIC_API_KEY": "your-key"
}
```

2. Start the agent:

```bash
npm run dev:agent
```

3. In another terminal, start the minimal CLI:

```bash
npm run chat:agent
```

CLI options:

```bash
npm run chat:agent -- --agent-id agent-dev
npm run chat:agent -- --workspace /absolute/path/to/workspace
npm run chat:agent -- --session cli:resume-me
npm run chat:agent -- --resume
```

If `tsx` is not suitable in your environment, you can build first and run the compiled entrypoints from `apps/agent/dist/` and `apps/cli/dist/`.
