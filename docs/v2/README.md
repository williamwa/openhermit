# OpenHermit v2 Planning Track

This folder holds the next planning track for OpenHermit.

`v1` remains the frozen description of the current implementation.

`v2` starts from the current codebase, but changes some important architectural boundaries:

- memory becomes program-managed state rather than workspace-managed state
- scheduling becomes a program-level subsystem rather than a per-agent heartbeat pattern
- the per-agent runtime becomes a more focused execution engine
- future multi-agent support should build on shared program-level storage and orchestration

## Documents

- Architecture direction: [architecture.md](architecture.md)
- Planning track: [plan.md](plan.md)
