# CloudMind

A host-based autonomous agent platform with persistent workspaces and memory, using Docker as an isolated execution and service sandbox.

`openHermit` is the planned new name for this project. Like a hermit crab living inside its protective shell, an agent can use shells and containers as its sandbox: protected, autonomous, and able to operate safely while still interacting with the outside world. The system is designed for strong agent autonomy, sandboxed execution, and native multi-agent collaboration.

## Core Goals

- **Sandboxed Execution**: Code execution and long-running services run in isolated Docker containers controlled by the agent
- **Lifecycle Management**: Support both ephemeral (short-term) and persistent (long-term) agents
- **Memory System**: Multi-layer memory — working memory, episodic memory, long-term knowledge
- **API-first**: All agent operations exposed via a clean HTTP + SSE API
- **Cloud-native**: Deployable on any VPS/cloud, orchestrated via Docker Compose or Kubernetes

## Repository Structure

```text
cloudmind/
├── apps/
│   ├── agent/                # Current focus: single-agent runtime (Hono + session API)
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

> Coming soon — see docs/plan.md for current development status.
