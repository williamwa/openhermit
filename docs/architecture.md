# Architecture Docs

OpenHermit now keeps architecture docs in versioned tracks.

## Current Tracks

- `v1`: the current host-agent architecture that matches the implemented codebase
- `v2`: the next architecture track for program-level memory, scheduling, and future multi-agent support

## Documents

- Current implemented architecture: [docs/v1/architecture.md](v1/architecture.md)
- Next architecture planning: [docs/v2/architecture.md](v2/architecture.md)

## Scope Split

Use `v1` when you need:

- the current single-agent runtime model
- the current workspace layout
- the current HTTP/SSE API contract
- the current file-based memory implementation

Use `v2` when you need:

- the next memory architecture
- program-level persistence and scheduling
- multi-agent-ready control-plane planning
