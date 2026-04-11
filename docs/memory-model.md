# OpenHermit Memory Model

This document defines the current memory model after the MemoryProvider refactor.

## Core Distinction

OpenHermit separates:

- `system memory`
- `user-authored knowledge`

System memory is runtime-owned internal state.  
User-authored knowledge is external state that the agent can read and edit through workspace tools.

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

## 3. Long-Term Memory

Long-term memory is managed through the `MemoryProvider` interface. The default implementation is `SqliteMemoryProvider`, which stores memories in `state.sqlite`.

### MemoryProvider Interface

```ts
interface MemoryProvider {
  readonly name: string;
  initialize(scope: StoreScope): Promise<void>;
  shutdown(): Promise<void>;
  add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry>;
  search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined>;
  update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry>;
  delete(scope: StoreScope, id: string): Promise<void>;
  getContextBlock(scope: StoreScope): Promise<string | undefined>;
}
```

The provider is pluggable — different agents can use different memory backends (SQLite, Mem0, Zep, etc.) while the agent-facing tools remain the same.

### Memory Entry Shape

```ts
interface MemoryEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
```

Memories are identified by `id` (e.g. `project/plan`, `user/preferences`, or auto-generated `mem-{uuid}`). Structured metadata replaces the previous title/tags fields.

### Context Injection

The runtime calls `getContextBlock()` on each turn to inject relevant long-term memory into the agent's context. The default SqliteMemoryProvider returns the 5 most recently updated memories formatted as markdown sections.

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

- `exec` (shell commands inside the workspace container)

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

This turn is program-triggered, not user-triggered.

The runtime decides when a checkpoint should happen.  
The agent does not decide whether checkpointing exists, but it does perform the checkpoint work.

Checkpoint triggers should include:

- explicit checkpoint
- adapter session switch such as `/new`
- idle timeout
- `memory.checkpoint_turn_interval`

The config name `memory.checkpoint_turn_interval` can stay as-is.  
It currently lives in `~/.openhermit/{agent-id}/config.json`.  
Its meaning is: after every N completed agent runs, run one checkpoint turn.
One run is counted from `agent_start` to `agent_end`, even if it contains multiple internal LLM steps or intermediate assistant messages.

Inputs for a checkpoint turn should include:

- the new session-log range since the last memory checkpoint
- previous session-local working memory
- current session metadata

Outputs of a checkpoint turn should include:

- a new episodic checkpoint, if warranted
- rewritten session-local working memory

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

Then it should extract only stable, durable information and write it into long-term memory via the MemoryProvider.

This is how transient activity becomes persistent memory.

#### 2. Explicit user instruction

If the user directly says things like:

- `remember this`
- `remember that I prefer ...`
- `save this as a long-term preference`

then the agent should be able to update long-term memory directly in that turn using `memory_add` or `memory_update`.

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

Long-term memory supports:

- explicit user-directed remembering
- future recall across sessions

OpenHermit exposes five agent-facing memory tools:

#### `memory_add`

Purpose:

- create a new memory entry, or upsert by ID

Parameters:

- `content` (required)
- `id` (optional — stable key like `project/plan` or auto-generated)
- `metadata` (optional — `Record<string, unknown>`)

#### `memory_get`

Purpose:

- read one memory entry by exact ID

Parameters:

- `id`

Result:

- one full memory entry with id, content, metadata, createdAt, updatedAt

#### `memory_recall`

Purpose:

- search memories by keyword or phrase

Parameters:

- `query`
- `limit` (optional)

Result:

- matching memory entries

#### `memory_update`

Purpose:

- update an existing memory entry's content or metadata

Parameters:

- `id`
- `content` (optional)
- `metadata` (optional)

#### `memory_delete`

Purpose:

- remove a memory entry that is no longer relevant

Parameters:

- `id`

### Retrieval Strategy

Long-term memory context is injected via `getContextBlock()` on each turn, which returns a curated subset of recent memories. The agent can also explicitly search via `memory_recall` or look up by ID via `memory_get`.

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
- not replace episodic checkpoints or long-term memory

## Summary

- session log = raw factual history
- episodic memory = checkpoint summaries
- working memory = active session state
- long-term memory = durable knowledge via MemoryProvider
- user-authored knowledge = external files, not system memory
- every checkpoint should be executed as a program-triggered internal agent turn
- long-term memory should update through idle consolidation and explicit user instruction
