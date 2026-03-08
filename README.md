# CloudMind

A host-based autonomous agent platform with persistent workspaces and memory, using Docker as an isolated execution and service sandbox.

## Core Goals

- **Sandboxed Execution**: Code execution and long-running services run in isolated Docker containers controlled by the agent
- **Lifecycle Management**: Support both ephemeral (short-term) and persistent (long-term) agents
- **Memory System**: Multi-layer memory — working memory, episodic memory, long-term knowledge
- **API-first**: All agent operations exposed via a clean HTTP + SSE API
- **Cloud-native**: Deployable on any VPS/cloud, orchestrated via Docker Compose or Kubernetes

## Project Structure

```
cloudmind/
├── agent/          # Agent core logic, LLM integration, tool execution
├── sandbox/        # Docker sandbox management, filesystem isolation
├── memory/         # Memory subsystems (working, episodic, long-term)
├── api/            # HTTP + SSE API server
├── infra/          # Docker Compose, Kubernetes configs, deployment scripts
└── docs/           # Architecture, planning, ADRs
```

## Quick Start

> Coming soon — see docs/plan.md for current development status.
