# Sandbox Model (Draft)

This document is a working draft.

It records possible sandbox directions discussed for OpenHermit.

It is not yet the implemented source of truth.

## Current Baseline

OpenHermit currently assumes:

- the main agent runtime runs on the host
- containers are sandboxed tools and services controlled by the host runtime
- internal runtime state remains host-owned

This baseline is still the current architectural decision.

## Why This Draft Exists

OpenHermit needs a clearer sandbox model for several different kinds of work:

- one-off execution such as running code or tests
- long-running supporting services
- a future everyday environment where an agent may repeatedly return to the same isolated system state

Those are related, but they are not the same sandbox shape.

## Proposed Sandbox Shapes

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

### 3. Daily Sandbox

Purpose:

- a persistent working environment for an agent's regular activity
- a place where installed tools and accumulated environment state survive across runs
- a safer alternative to giving the main host runtime broad mutable host access

Characteristics:

- persists across agent restarts
- expected to restore prior environment state
- suitable for repeated daily use by the same agent
- should still remain more controlled than raw host execution

Examples:

- an agent's normal coding environment
- a long-lived toolchain environment
- a reusable workstation-like sandbox for autonomous work

## NixOS-Inspired Direction

One possible direction is to use NixOS for the daily sandbox shape.

The attraction is not "run the whole platform inside NixOS" by default.
The attraction is that NixOS already has strong primitives for:

- declarative environment description
- reproducible builds
- system state restoration after restart
- generation-based switching and rollback

For OpenHermit, that suggests a possible daily-sandbox model:

- the host runtime remains the orchestrator
- the agent's everyday execution environment lives inside a NixOS-based sandbox
- the sandbox can be rebuilt, resumed, and rolled back using existing NixOS mechanisms
- persistent agent work can return to a known environment after machine or process restart

## Open Questions

This draft intentionally keeps several questions open:

- should the daily sandbox be a container, microVM, or another isolated host-managed environment?
- should only selected workloads move into the daily sandbox, or should most ordinary agent execution happen there?
- how should workspace mounts and internal-state access be brokered into a daily sandbox?
- should service sandboxes and daily sandboxes share the same runtime substrate?
- how much of skill installation should target ephemeral sandboxes versus the daily sandbox?
- what lifecycle model best matches a NixOS-based daily sandbox: rebuild, activate, rollback, snapshot, or some combination?

## Current Status

Status: draft only.

Next steps:

1. Keep the current host-runtime architecture as the implemented baseline.
2. Continue researching how much of OpenHermit's execution should move into a daily sandbox.
3. Explore whether NixOS should back only the daily sandbox shape, not the entire host runtime.
4. Design future skill and extension lifecycle around explicit sandbox targets instead of one generic execution model.
