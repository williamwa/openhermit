# OpenHermit v2 Plan

This is the next planning track after the current `v1` implementation baseline.

## Goals

- separate external task files from internal runtime state
- move memory out of per-agent workspaces
- move identity state out of per-agent workspaces
- replace heartbeat-centric background behavior with a general scheduler
- prepare the system for future multi-agent and gateway work

## Phase A — Freeze v1

- treat [docs/v1/plan.md](../v1/plan.md) as the current implementation baseline
- stop evolving the `v1` docs except for factual corrections
- keep new architecture work in `docs/v2/`

## Phase B — Program Store Foundation

Define a program-managed persistence layer outside the workspace.

Target responsibilities:

- identity state
- sessions
- messages
- session summaries
- working memory
- long-term memory
- bindings
- approvals
- schedules
- schedule runs
- container runtime inventory

Initial backend:

- SQLite

Initial output:

- schema draft
- storage abstraction boundaries
- migration plan from `v1` file-based state

## Phase C — Memory Re-Architecture

Move memory from workspace files into the program store.

Expected result:

- raw session history stays queryable in the session store
- episodic checkpoints become program-owned records
- session-local working memory becomes program-owned state
- global working memory becomes program-owned state
- long-term system memory becomes program-owned state

External workspace should still be able to contain user-authored knowledge files, but those should no longer be conflated with system memory.

## Phase C.1 — Identity Re-Architecture

Split identity into:

- user-authored identity inputs
- internal identity state

This preserves user editability without keeping runtime-owned identity state in the external workspace.

## Phase D — Scheduler

Add a program-level scheduler that can dispatch work into agents.

The scheduler should support:

- `cron`
- `interval`
- `at`
- `event`
- `dependency`

Each schedule definition should include:

- `trigger`
- `task`
- `execution`
- `output`
- `dependencies`
- `metadata`

The agent runtime should receive scheduled work as ordinary session/runs, rather than embedding schedule policy inside the agent.

Heartbeat should be treated as one kind of scheduled task or handler, not as the scheduling model itself.

## Phase E — Gateway / Multi-Agent

Build a control-plane layer on top of the program store.

Responsibilities:

- multi-agent creation and lifecycle
- channel and adapter orchestration
- session/binding routing
- schedule management
- monitoring
- unified APIs such as `/agents/{id}/...`

## Immediate Next Design Tasks

1. Define the `v2` SQLite schema.
2. Decide how `v1` workspace-based memory maps into `v2` internal state storage.
3. Separate user-authored knowledge and identity inputs from system-managed state.
4. Define scheduler task handlers and execution semantics.
5. Decide how container runtime state and mounted task data split across internal and external state.
