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

## 2. Active Memory

Active memory should be split into:

- `session-local working memory`
- `now`

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

### `now`

Purpose:

- hold the agent's current cross-session state
- record what the agent is working on right now

Examples:

- I am working in `session:cli:...` on email triage
- I am working in `session:web:...` on a feature implementation
- current important active threads
- recent cross-session decisions
- important currently running services

Storage:

- internal state
- stored in `state.sqlite`
- keyed in the shared `memories` table under the memory key `now`

## 3. Durable Memory

Durable memory should be split into:

- `main`
- structured named memories
- `user-authored knowledge`

### `main`

Purpose:

- the primary stable memory for one agent
- stable reusable facts the runtime decides are worth preserving

Examples:

- persistent user preferences
- stable project conventions
- long-lived operational knowledge

Storage:

- internal state
- stored in `state.sqlite`
- keyed in the shared `memories` table under the memory key `main`

### Structured Named Memories

Purpose:

- organize memory by topic instead of only by layer

Examples:

- `project/openhermit/plan`
- `project/openhermit/architecture`
- `user/preferences/communication`
- `ops/railway/production`

Rule:

- use keys to express the purpose and topic of the memory
- prefer structured keys when the memory belongs to a specific project, user preference set, or operational domain

Agent-facing tools:

- `memory_get`
- `memory_recall`
- `memory_update`

These tools are for named system memories such as `main`, `now`, and structured keys.

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

Checkpointing should not be confused with compaction.

- checkpointing updates memory
- compaction keeps long session context within model limits

### Checkpoint Turn

OpenHermit should treat a checkpoint as an internal agent turn.

This is a checkpoint turn driven by the runtime, but executed by the same agent.

Its purpose is:

- reflect on what happened since the last checkpoint
- decide whether the session state changed in a meaningful way
- update episodic memory
- update session-local working memory
- optionally refresh `now`

This turn is program-triggered, not user-triggered.

The runtime decides when a checkpoint should happen.  
The agent does not decide whether checkpointing exists, but it does perform the checkpoint work.

Checkpoint triggers should include:

- explicit checkpoint
- adapter session switch such as `/new`
- idle timeout
- `memory.checkpoint_turn_interval`

The config name `memory.checkpoint_turn_interval` can stay as-is.  
Its meaning is: after every N completed agent runs, run one checkpoint turn.
One run is counted from `agent_start` to `agent_end`, even if it contains multiple internal LLM steps or intermediate assistant messages.

Inputs for a checkpoint turn should include:

- the new session-log range since the last memory checkpoint
- previous session-local working memory
- current session metadata
- optionally recent `now`

Outputs of a checkpoint turn should include:

- a new episodic checkpoint, if warranted
- rewritten session-local working memory
- optionally refreshed `now`

Checkpointing should not be responsible for fixing oversized model context windows.
That is the role of compaction.

### Long-Term Consolidation

Durable memory should not be rewritten on every turn.

Instead, durable-memory consolidation should happen through two paths:

#### 1. Idle / sleep-time consolidation

When the system is idle for long enough, especially during user-local low-activity periods such as sleeping hours, OpenHermit should run a consolidation pass.

That pass should read:

- recent session logs
- episodic memory
- working memory

Then it should extract only stable, durable information and write it into named durable memory such as `main` or structured keys.

This is how transient activity becomes persistent memory.

#### 2. Explicit user instruction

If the user directly says things like:

- `remember this`
- `remember that I prefer ...`
- `save this as a long-term preference`

then the agent should be able to update long-term memory directly in that turn.

This path should be immediate, not deferred to idle consolidation.

## Memory Tool Boundaries

OpenHermit should not expose all memory layers as generic agent tools.

### No direct tools for episodic or working memory

Episodic memory and working memory are runtime-managed internal state.

They should be:

- generated by checkpoint turns
- injected into context by the runtime
- updated by program-driven lifecycle logic

They should not be treated as ordinary mutable tools the agent can freely rewrite at any time.

### Long-term memory tools

Named durable memory is different because it supports:

- explicit user-directed remembering
- future recall across sessions

OpenHermit should therefore expose three agent-facing memory tools:

#### `memory_get`

Purpose:

- read one named system memory by exact key
- fetch the full current content before rewriting it

Typical parameters:

- `key`

Typical result:

- one full memory entry with key, content, and metadata

#### `memory_recall`

Purpose:

- search and retrieve named system memory

Typical parameters:

- `query`
- `limit`
- optional tags or filters

Typical result:

- matching memory entries with keys, title, snippet/content, and metadata

#### `memory_update`

Purpose:

- create or update named memory when the user explicitly asks the agent to remember something

Typical parameters:

- `key` or generated id
- `title`
- `content`
- `tags`
- update mode such as `upsert`

This tool should not update episodic memory or working memory.

Recommended conventions:

- use `main` for durable cross-session facts
- use `now` for the current cross-session state
- use structured keys such as `project/...` or `user/preferences/...` for topic-specific memory

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
- rewritten `now`
- promoted long-term memory content

This keeps memory behavior predictable while still using the model for summarization quality.

## Compaction

Compaction is a runtime context-management mechanism, not a memory layer.

Its purpose is:

- keep long-running sessions usable
- reduce context size when a session approaches model limits
- preserve the most relevant recent turns while compressing older material

Compaction should:

- operate on session history
- be triggered by context-window pressure rather than by normal memory cadence
- cooperate with checkpoint outputs and working memory
- not replace episodic checkpoints, `now`, or `main`

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

OpenHermit should expose:

- `memory_get`
- `memory_recall`
- `memory_update`

Recommended usage:

- use `memory_recall` to discover relevant named memories
- use `memory_get` to read the full current content of one memory
- use `memory_update` to rewrite or extend the chosen memory key

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
