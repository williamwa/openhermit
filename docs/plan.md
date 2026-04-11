# OpenHermit Plan

This document tracks the current implementation status and the next major work items.

## Current State

OpenHermit already has a working single-agent runtime with:

- host-based agent execution
- per-agent internal state in `~/.openhermit/{agent-id}/`
- per-agent internal runtime config in `~/.openhermit/{agent-id}/config.json`
- `state.sqlite` as the primary internal-state store
- `runtime.json` for local API discovery
- startup / shutdown protection around `runtime.json`
- agent-local HTTP + SSE API
- CLI client
- local web client
- approval gate
- workspace execution, web, memory, instruction, and container tools

The main architectural direction is now stable:

- `external state` stays in the workspace
- `internal state` stays outside the workspace
- checkpointing is agent-driven
- compaction should become the next major runtime capability
- scheduler will be extracted from heartbeat-specific logic

There are also several active design drafts that are intentionally not yet implemented as architecture commitments:

- participant / role model
- sandbox model
- storage abstraction model

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
- lightweight versioned migrations inside the agent runtime
- sessions and session logs migrated out of workspace files
- episodic checkpoints migrated out of workspace files
- session-local working memory migrated into `sessions`
- named memories migrated into `memories`
- container runtime inventory migrated into `state.sqlite`
- workspace scaffold no longer creates `memory/`, `sessions/`, or `runtime/`
- workspace scaffold now keeps agent-managed external config and identity files under `workspace/.openhermit/`

### Memory Foundations

- checkpoint-based episodic memory
- configurable `memory.checkpoint_turn_interval` in internal runtime config
- checkpoint endpoint
- agent-driven internal checkpoint turns
- session-local working memory
- pluggable `MemoryProvider` interface (default: `SqliteMemoryProvider`)
- `getContextBlock()` for per-turn memory injection
- agent-facing memory tools:
  - `memory_add`
  - `memory_get`
  - `memory_recall`
  - `memory_update`
  - `memory_delete`
- initial prompt-budget compaction for long sessions

### Tooling

- `workspace_exec` (command execution in workspace container)
- `web_fetch`
- container tools (`container_start`, `container_stop`, `container_exec`, `container_run`, `container_status`)
- configurable container `mount_target`
- instruction tools (`instruction_read`, `instruction_update`)

## Remaining Major Work

## Draft Design Tracks

These tracks are being explored in documentation but are not yet committed implementation directions.

### Participant Model Draft

- separate:
  - connection role
  - participant identity
  - relationship / access
  - session routing
- define the minimum participant context needed before pair and channel work lands
- keep participant-scoped memory separate from agent identity files

### Sandbox Model Draft

- distinguish three sandbox shapes:
  - `ephemeral`
  - `service`
  - `daily`
- evaluate whether a future `daily sandbox` should host ordinary agent work while the main runtime remains on the host
- continue exploring NixOS as a candidate substrate for the `daily sandbox`, especially for restart recovery and generation-style environment management

### Storage Model Draft

- keep agent-facing document access compatible with file-like operations
- explore a `DocumentStore` abstraction for external state
- keep internal runtime state on domain-specific stores rather than flattening everything into document APIs
- evaluate whether selective virtual document views over internal state are useful later
- keep both local filesystem-friendly and cloud/database-backed deployment shapes viable

## Phase 1 — Finish Internal/External State Separation

### 1.1 Identity Split

- keep `workspace/.openhermit/*.md` as workspace-authored, editable, canonical identity inputs
- decide whether a normalized internal identity cache is still useful as a derived view
- ensure prompt construction treats workspace identity files as the source of truth

### 1.2 Durable Memory Refinement

- finalize the boundary between:
  - system memory (via MemoryProvider)
  - user-authored knowledge (workspace files)
- formalize structured key conventions such as:
  - `project/...`
  - `user/preferences/...`
  - `ops/...`
- refine `getContextBlock()` retrieval strategy beyond "most recent 5"
- define when idle consolidation may promote transient knowledge into long-term memory

### 1.3 Long-Term Consolidation

- add idle-time consolidation passes
- support user-local low-activity / sleep-time consolidation windows
- promote durable facts from:
  - session logs
  - episodic checkpoints
  - session-local working memory
- write promoted results into long-term memory via MemoryProvider

## Phase 2 — Runtime Compaction

- refine token-aware context budgeting for long sessions
- improve the current compaction artifact and retention policy
- decide when compaction should proactively happen versus only when near budget
- evaluate whether user-visible retry is still needed beyond the current first pass
- keep compaction distinct from checkpointing:
  - checkpointing updates memory
  - compaction keeps the runtime context window healthy
- make compaction cooperate with:
  - episodic checkpoints
  - session-local working memory

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
- improve how `workspace/.openhermit/*.md` is loaded, composed, and validated without moving canonical ownership into internal state
- improve the agent's use of memory tools (`memory_add`, `memory_get`, `memory_recall`, `memory_update`, `memory_delete`)
- add explicit “remember this” behavior on top of the MemoryProvider
- connect any future normalized identity cache to prompt construction as a derived layer, not as canonical storage

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

1. tighten the identity loading model while keeping `workspace/.openhermit/*.md` canonical in the workspace
2. refine runtime compaction beyond the current first pass
3. define the durable-memory vs user-knowledge boundary more tightly
4. continue design work on:
   - participant model
   - sandbox model
   - storage abstraction
5. implement idle / sleep-time long-term consolidation
6. design and implement the scheduler

## Design Constraints

- do not preserve legacy compatibility unless explicitly requested
- internal state should not flow back into the workspace by default
- user-editable inputs and runtime-managed state must remain distinct
- episodic memory and session-local working memory remain runtime-managed
- agent-facing memory tools target the MemoryProvider interface
- mounted container task data remains external state even though container runtime inventory is internal state
