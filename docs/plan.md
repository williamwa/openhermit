# OpenHermit Plan

This is the current implementation and migration plan.

## Current Direction

OpenHermit is moving toward:

- external workspace for task files
- per-agent internal state under `~/.openhermit/{agent-id}/`
- `state.sqlite` as the primary internal-state store
- `runtime.json` as the runtime discovery file
- scheduler extracted from heartbeat-specific logic

## Completed So Far

### Agent Runtime

- host-based agent runtime
- `pi-agent-core` integration
- HTTP + SSE agent-local API
- approval gate
- CLI client
- local web client

### Tools

- file tools
- `file_search`
- `web_fetch`
- container tools

### Session Layer

- session listing
- session history API
- session descriptions
- session events over SSE
- session persistence in per-agent `state.sqlite`

### Memory Foundations

- checkpoint-based episodic summaries
- session checkpoint endpoint
- configurable checkpoint turn interval
- session-local working memory stored in `sessions`
- named memories stored in `memories`, including `main` and `now`
- checkpoint execution is moving from external summarization toward agent-driven internal checkpoint turns

### Internal State Migration

- per-agent `state.sqlite`
- per-agent `runtime.json`
- sessions and session logs migrated out of workspace files
- episodic checkpoints migrated out of workspace files
- workspace scaffold no longer creates `memory/`, `sessions/`, or `runtime/`

## Next Steps

## Phase 1 — Finish Internal/External State Separation

### 1.1 Working Memory Migration
Completed.

### 1.2 Long-Term Memory Rework

- decide what belongs to named system memory vs user-authored knowledge
- store named system memory in `state.sqlite`
- keep user-authored knowledge in external files
- support explicit user-driven long-term memory updates
- add `memory_get` for exact named-memory reads before rewriting
- add `memory_recall` for agent-facing named-memory retrieval
- add `memory_update` for explicit named-memory writes
- define conventions for:
  - `main`
  - `now`
  - structured keys such as `project/...`

### 1.3 Agent-Driven Checkpoint Turns

- keep `memory.checkpoint_turn_interval` as the checkpoint trigger config
- make checkpoint execution run through the agent itself, not a bare external summarizer
- use the new session-log range plus existing memory state as input
- update episodic and working memory through this checkpoint turn
- prepare the same lifecycle for future long-term consolidation

### 1.4 Identity Split

- treat `identity/*.md` as user-authored identity inputs
- define normalized internal identity state
- stop treating workspace identity files as canonical runtime state

### 1.5 Container Runtime Migration

- move container runtime inventory out of workspace files
- store runtime inventory in `state.sqlite`
- keep `containers/{name}/data/` as external task data

## Phase 2 — Scheduler

- replace heartbeat-centric scheduling with a general scheduler
- define schedule schema
- support triggers:
  - `cron`
  - `interval`
  - `at`
  - `event`
  - `dependency`
- add schedule execution state and retry policy
- dispatch scheduled work into agents as ordinary sessions/runs

## Phase 3 — Web + Channel Maturity

- improve web UX on top of the existing client
- add Telegram as a first real channel adapter
- make adapter/session binding first-class across channels

## Phase 4 — Gateway / Multi-Agent

- multi-agent lifecycle management
- unified `/agents/{id}/...` routing
- centralized monitoring
- schedule management at control-plane level

## Immediate Implementation Order

1. define the split between system long-term memory and user-authored knowledge
2. implement agent-driven checkpoint turns
3. migrate container runtime inventory into `state.sqlite`
4. design and implement the scheduler
5. split identity inputs from normalized internal identity state

## Design Constraints

- no backward-compatibility layer is required during development
- internal state should not flow back into the workspace by default
- user-editable inputs and agent-managed runtime state must remain distinct
- episodic and working memory remain runtime-managed and are not exposed as generic agent tools
- agent-facing memory tools should target named system memory only
