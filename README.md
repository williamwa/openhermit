# CloudMind

A cloud-native autonomous agent platform that runs short-term and long-term AI agents inside isolated sandbox environments (Docker), with persistent filesystem and memory systems.

## Core Goals

- **Sandboxed Execution**: Each agent runs in an isolated Docker container with its own filesystem
- **Lifecycle Management**: Support both ephemeral (short-term) and persistent (long-term) agents
- **Memory System**: Multi-layer memory — working memory, episodic memory, long-term knowledge
- **API-first**: All agent operations exposed via a clean REST + WebSocket API
- **Cloud-native**: Deployable on any VPS/cloud, orchestrated via Docker Compose or Kubernetes

## Project Structure

```
cloudmind/
├── agent/          # Agent core logic, LLM integration, tool execution
├── sandbox/        # Docker sandbox management, filesystem isolation
├── memory/         # Memory subsystems (working, episodic, long-term)
├── api/            # REST + WebSocket API server
├── infra/          # Docker Compose, Kubernetes configs, deployment scripts
└── docs/           # Architecture, planning, ADRs
```

## Quick Start

> Coming soon — see docs/plan.md for current development status.
