# OpenHermit Memory Model

This document defines the current target memory model after the internal/external state split.

## Core Distinction

OpenHermit separates:

- `system memory`
- `user-authored knowledge`

System memory is runtime-owned internal state.  
User-authored knowledge is external state that the agent can read, search, and edit like normal files.

They are related, but they are not the same thing.

## Memory Layers

OpenHermit uses three logical system-memory layers:

1. episodic memory
2. working memory
3. long-term memory

Session logs remain the factual source of truth, but they are not considered a memory layer themselves.

## Session Log

Purpose:

- factual source of truth for one session
- replay
- audit
- history API
- input for memory generation

Storage:

- internal state
- persisted in `~/.openhermit/{agent-id}/state.sqlite`

Contents:

- user messages
- assistant messages
- tool events
- approvals
- errors
- other per-session events

Rule:

- if it happened in a session, it belongs in the session log first

## 1. Episodic Memory

Purpose:

- compact checkpoint summaries with future retrieval value
- bridge from raw session history into higher-level memory

Storage:

- internal state
- persisted in `state.sqlite`
- stored as checkpoint-style records, not raw event mirrors

Rule:

- episodic memory is not a duplicate transcript
- it stores checkpoint outputs only

Fields should include:

- `session_id`
- `ts`
- `checkpoint_type`
- `reason`
- `history_from`
- `history_to`
- `turn_count`
- `summary`

## 2. Working Memory

Working memory should be split into:

- `session-local working memory`
- `global working memory`

### Session-Local Working Memory

Purpose:

- preserve the active thread state of one session
- keep continuity without replaying full history

Examples:

- current objective
- recent conclusions
- open questions
- next steps
- session-specific constraints

Storage:

- internal state
- session-local working memory is stored on the session record

### Global Working Memory

Purpose:

- hold cross-session, high-signal current context for one agent

Examples:

- important active threads
- recent cross-session decisions
- important currently running services
- short-lived cross-session context

Storage:

- internal state
- stored in `state.sqlite`
- keyed inside the shared `memories` table

## 3. Long-Term Memory

Long-term memory should be split into:

- `system long-term memory`
- `user-authored knowledge`

### System Long-Term Memory

Purpose:

- stable reusable facts the runtime decides are worth preserving

Examples:

- persistent user preferences
- stable project conventions
- long-lived operational knowledge

Storage:

- internal state
- stored in `state.sqlite`
- keyed inside the shared `memories` table

### User-Authored Knowledge

Purpose:

- files the user wants the agent to read and work with directly

Examples:

- docs
- project notes
- prompts
- curated knowledge files

Storage:

- external workspace

Access:

- `file_search`
- `read_file`
- `list_files`

## Memory Lifecycle

OpenHermit should manage memory in two main phases:

- `self-introspection`
- `long-term consolidation`

### Checkpoint Turn

OpenHermit should treat a checkpoint as an internal agent turn.

This is a checkpoint turn driven by the runtime, but executed by the same agent.

Its purpose is:

- reflect on what happened since the last checkpoint
- decide whether the session state changed in a meaningful way
- update episodic memory
- update session-local working memory
- optionally refresh global working memory

This turn is program-triggered, not user-triggered.

The runtime decides when a checkpoint should happen.  
The agent does not decide whether checkpointing exists, but it does perform the checkpoint work.

Checkpoint triggers should include:

- explicit checkpoint
- adapter session switch such as `/new`
- idle timeout
- `memory.checkpoint_turn_interval`

The config name `memory.checkpoint_turn_interval` can stay as-is.  
Its meaning is: after every N completed user-visible turns, run one checkpoint turn.

Inputs for a checkpoint turn should include:

- the new session-log range since the last memory checkpoint
- previous session-local working memory
- current session metadata
- optionally recent global working memory

Outputs of a checkpoint turn should include:

- a new episodic checkpoint, if warranted
- rewritten session-local working memory
- optionally refreshed global working memory

### Long-Term Consolidation

Long-term memory should not be rewritten on every turn.

Instead, long-term consolidation should happen through two paths:

#### 1. Idle / sleep-time consolidation

When the system is idle for long enough, especially during user-local low-activity periods such as sleeping hours, OpenHermit should run a consolidation pass.

That pass should read:

- recent session logs
- episodic memory
- working memory

Then it should extract only stable, durable information and write it into system long-term memory.

This is how transient activity becomes persistent memory.

#### 2. Explicit user instruction

If the user directly says things like:

- `remember this`
- `remember that I prefer ...`
- `save this as a long-term preference`

then the agent should be able to update long-term memory directly in that turn.

This path should be immediate, not deferred to idle consolidation.

## Orchestration Responsibility

Memory behavior should be split between:

- program-driven orchestration
- agent-generated memory content

### Program-Driven

The program should decide:

- when checkpoint turns run
- what transcript range it sees
- when to checkpoint episodic memory
- when to refresh working memory
- when to run long-term consolidation
- where results are stored

### Agent-Generated

The agent should generate:

- episodic summaries
- rewritten session-local working memory
- rewritten global working memory
- promoted long-term memory content

This keeps memory behavior predictable while still using the model for summarization quality.

## Memory Tools

Memory tools should be planned based on whether a memory layer is directly injected by the runtime or needs explicit manipulation by the agent.

### No Read Tool Needed For Prompt-Injected Memory

If a memory layer is already injected into the agent context by the runtime, the agent does not need a special read tool for that same layer.

This applies to:

- session-local working memory
- global working memory

These should be inserted into the prompt directly by the runtime.

### Explicit Tools Needed For Long-Term Memory Mutation

Long-term memory is different.

Because the user may explicitly ask the agent to remember or update a durable fact, the agent should have explicit mutation capability for system long-term memory.

This implies future tools such as:

- create long-term memory entry
- update long-term memory entry
- possibly delete or supersede long-term memory entry

The exact tool names can be decided later, but the capability should exist.

### Retrieval Strategy

System-managed long-term memory should not be blindly injected in full.

Instead, retrieval should be selective:

- direct lookup by key
- search by topic or metadata
- future ranking / retrieval logic

User-authored knowledge remains external and should continue to use normal file tools.

## Summary

- session log = raw factual history
- episodic memory = checkpoint summaries
- working memory = active state
- long-term memory = durable system knowledge
- user-authored knowledge = external files, not system memory
- every checkpoint should be executed as a program-triggered internal agent turn
- long-term memory should update through idle consolidation and explicit user instruction
