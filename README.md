# CloudMind

CloudMind is a host-run AI agent runtime that uses Docker containers as disposable tools.

This repository is currently docs-first. The immediate goal is to ship a narrow, reliable v0.1 before adding background autonomy or multi-channel features.

## v0.1 Contract

In scope for v0.1:

- One agent process running on the host
- CLI interface only
- One workspace per agent
- File-based memory and session logs
- Secrets and autonomy policy stored outside the workspace
- Four tools only: `read_file`, `write_file`, `list_files`, `container_run`
- Ephemeral Docker containers only

Explicitly out of scope for v0.1:

- Telegram, Discord, HTTP, or WebSocket transports
- Service containers and host port bindings
- Heartbeat / scheduled autonomous runs
- Tailscale Funnel
- Multi-agent management
- Custom hooks
- Web UI

## Docs

- `docs/architecture.md` defines the v0.1 implementation contract
- `docs/plan.md` defines the execution order for building v0.1
- `docs/decisions.md` captures architecture decisions and deferred future direction

## Status

The repository currently contains only planning docs. There is no runtime code yet.
