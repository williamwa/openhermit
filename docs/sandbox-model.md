# Sandbox Model

This document describes the sandbox model for OpenHermit.

## Current Baseline

OpenHermit currently implements:

- all agent work runs inside containers — no direct host execution
- the **workspace container** is the primary execution environment (workspace mounted at `/workspace`, used via `exec`)
- **service containers** run long-lived daemons (databases, web servers)
- **ephemeral containers** handle one-off isolated tasks
- the orchestration process manages containers and persists internal state

Three container types are implemented: `ephemeral`, `service`, and `workspace`.

## Sandbox Shapes

### 1. Ephemeral Sandbox

Purpose:

- one-shot tasks
- isolated command execution
- temporary dependency installation
- short-lived debugging or verification work

Characteristics:

- created on demand
- low persistence expectations
- safe to discard after the task finishes
- optimized for quick setup and teardown

Examples:

- run a test suite
- execute a script from an untrusted repo
- inspect a build failure in isolation

### 2. Service Sandbox

Purpose:

- long-running background services
- supporting infrastructure needed by the agent
- stable endpoints that multiple runs may depend on

Characteristics:

- survives beyond a single task
- exposes controlled ports or mounted data
- managed as runtime inventory, not as ordinary workspace files
- should be restartable and observable

Examples:

- local databases
- preview servers
- vector stores
- MCP sidecars or other helper daemons

### 3. Workspace Container

Purpose:

- a persistent execution environment for each agent
- the primary way agents run shell commands and interact with workspace files
- installed packages and state persist across commands within a session

Characteristics:

- created on demand when `exec` is first called
- workspace root mounted at `/workspace`
- persists across agent restarts (restarted if stopped)
- default image configurable per agent

This is the implemented sandbox for everyday agent work.

## Open Questions

- should the workspace container eventually support declarative environment description (e.g. NixOS-based) for reproducible builds and rollback?
- how should skill installation target specific sandbox types?
- should the workspace container substrate evolve beyond plain Docker containers (microVM, etc.)?
