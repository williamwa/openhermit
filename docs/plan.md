# OpenHermit Plan

This document tracks the current implementation status and the next major work items.

## Current State

OpenHermit already has a working single-agent runtime with:

- host-based agent execution
- per-agent internal state in `~/.openhermit/{agent-id}/`
- `state.sqlite` as the primary internal-state store
- `runtime.json` for local API discovery
- agent-local HTTP + SSE API
- CLI client
- local web client
- approval gate
- file, web, memory, and container tools

The main architectural direction is now stable:

- `external state` stays in the workspace
- `internal state` stays outside the workspace
- checkpointing is agent-driven
- compaction should become the next major runtime capability
- scheduler will be extracted from heartbeat-specific logic

## Completed

### Agent Runtime

- `pi-agent-core` integration
- session lifecycle and persistence
- SSE event streaming
- approval pause / resume flow
- session history API
- session listing API

### Clients

- CLI client with session switching and approvals
- local web client with chat and session list

### Internal State Migration

- per-agent `state.sqlite`
- per-agent `runtime.json`
- sessions and session logs migrated out of workspace files
- episodic checkpoints migrated out of workspace files
- session-local working memory migrated into `sessions`
- named memories migrated into `memories`
- container runtime inventory migrated into `state.sqlite`
- workspace scaffold no longer creates `memory/`, `sessions/`, or `runtime/`

### Memory Foundations

- checkpoint-based episodic memory
- configurable `memory.checkpoint_turn_interval`
- checkpoint endpoint
- agent-driven internal checkpoint turns
- session-local working memory
- named memories with first-class keys:
  - `main`
  - `now`
  - structured keys such as `project/...`
- agent-facing named-memory tools:
  - `memory_get`
  - `memory_recall`
- `memory_update`
- initial prompt-budget compaction for long sessions

### Tooling

- file tools
- `file_search`
- `web_fetch`
- container tools
- configurable container `mount_target`

## Remaining Major Work

## Phase 1 — Finish Internal/External State Separation

### 1.1 Identity Split

- treat `identity/*.md` as user-authored identity inputs
- define normalized internal identity state
- stop treating workspace identity files as canonical runtime state

### 1.2 Durable Memory Refinement

- finalize the boundary between:
  - named system memory
  - user-authored knowledge
- make `main` and `now` the default runtime-loaded memories
- formalize structured key conventions such as:
  - `project/...`
  - `user/preferences/...`
  - `ops/...`
- define when checkpoint turns may refresh `now`
- define when idle consolidation may refresh `main` and other durable keys

### 1.3 Long-Term Consolidation

- add idle-time consolidation passes
- support user-local low-activity / sleep-time consolidation windows
- promote durable facts from:
  - session logs
  - episodic checkpoints
  - session-local working memory
  - `now`
- write promoted results into:
  - `main`
  - structured named memories

## Phase 2 — Runtime Compaction

- add token-aware context budgeting for long sessions
- detect when a session is approaching model context limits
- introduce compaction artifacts that summarize older history while keeping recent turns
- retry the user-visible turn after compaction when context overflow or near-overflow occurs
- keep compaction distinct from checkpointing:
  - checkpointing updates memory
  - compaction keeps the runtime context window healthy
- make compaction cooperate with:
  - episodic checkpoints
  - session-local working memory
  - `now`

## Phase 3 — Scheduler

- replace heartbeat-centric scheduling with a general scheduler
- define schedule schema
- support triggers:
  - `cron`
  - `interval`
  - `at`
  - `event`
  - `dependency`
- add execution policy:
  - timeout
  - retry
  - backoff
  - concurrency
- dispatch scheduled work into agents as ordinary runs

## Phase 4 — Identity + Knowledge Maturity

- refine how user-authored knowledge is organized in the external workspace
- improve the agent's use of:
  - `memory_recall`
  - `memory_get`
  - `memory_update`
- add explicit “remember this” behavior on top of named memories
- connect normalized identity state to prompt construction

## Phase 5 — Web + Channel Maturity

- improve web UX on top of the existing client
- add Telegram as the first real channel adapter
- make adapter/session binding first-class across channels

## Phase 6 — Gateway / Multi-Agent

- multi-agent lifecycle management
- unified `/agents/{id}/...` routing
- centralized monitoring
- schedule management at control-plane level

## Immediate Implementation Order

1. split identity inputs from normalized internal identity state
2. design and implement runtime compaction
3. define the durable-memory vs user-knowledge boundary more tightly
4. implement idle / sleep-time long-term consolidation
5. design and implement the scheduler

## Design Constraints

- do not preserve legacy compatibility unless explicitly requested
- internal state should not flow back into the workspace by default
- user-editable inputs and runtime-managed state must remain distinct
- episodic memory and session-local working memory remain runtime-managed
- agent-facing memory tools should target named system memory only
- mounted container task data remains external state even though container runtime inventory is internal state
