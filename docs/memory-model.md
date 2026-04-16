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

OpenHermit uses two logical system-memory layers:

1. working memory
2. long-term memory

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
- persisted in PostgreSQL (scoped by `agent_id`)

Contents:

- user messages
- assistant messages
- tool events
- approvals
- errors
- other per-session events

Rule:

- if it happened in a session, it belongs in the session log first

## 1. Working Memory

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

## 2. Long-Term Memory

Long-term memory is managed through the `MemoryProvider` interface. The default implementation is `DbMemoryProvider`, which stores memories in PostgreSQL with native `tsvector` full-text search (English stemming, `ts_rank` ranking) via a GIN-indexed generated stored column.

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

The provider is pluggable — different agents can use different memory backends (PostgreSQL, Mem0, Zep, etc.) while the agent-facing tools remain the same.

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

Introspection should not be confused with compaction.

- introspection updates memory (working memory + long-term memory)
- compaction keeps long session context within model limits

### Introspection Turn

OpenHermit treats introspection as an internal agent turn with access to memory tools.

A lightweight introspection agent is given:

- memory tools: `memory_recall`, `memory_add`, `memory_update`, `memory_delete`
- working memory tool: `working_memory_update`
- session description tool: `session_description_update`

Its purpose is:

- reflect on conversation activity since the last introspection
- update long-term memory for information with durable value
- refresh session-local working memory with current state
- update the session description (title) when it becomes stale or is missing

This turn is program-triggered, not user-triggered.

The runtime decides when introspection should happen.
The agent performs the introspection work using real tool calls.

Introspection events are recorded as a span in `session_events`:

- `introspection_start` — marks the beginning
- `tool_call` / `tool_result` — each memory tool call
- `introspection_end` — marks completion with a summary of changes

The main agent sees this span in its timeline on subsequent turns.

Configuration lives in `~/.openhermit/{agent-id}/config.json` under `memory.introspection`:

- `enabled` — set to `false` to disable automatic introspection
- `turn_interval` — run introspection every N completed runs (default: 5)
- `idle_timeout_minutes` — run after N minutes of inactivity (default: 10)
- `max_tool_calls` — cap tool calls per introspection (default: 10)
- `model` — override model for introspection agent (default: same as main agent)

Introspection triggers:

- explicit request
- adapter session switch such as `/new`
- idle timeout
- turn interval

Introspection should run more frequently than compaction. This ensures it always operates on raw, uncompressed conversation data — never on compaction summaries.

Introspection should not be responsible for fixing oversized model context windows.
That is the role of compaction.

### Memory Write Paths

Memory is updated through two paths:

#### 1. Introspection (automatic)

The reliable, periodic path. Even if the agent never calls memory tools during conversation, introspection will periodically reflect and persist what matters.

#### 2. Explicit agent tool use

If the user directly says things like:

- `remember this`
- `remember that I prefer ...`

then the main agent can update long-term memory immediately using `memory_add` or `memory_update`.

This path is responsive but not reliable — the agent may forget to use it.

## Memory Tools

### Working memory ownership

Working memory is exclusively managed by the introspection agent via the `working_memory_update` tool. The main agent does not have access to this tool. This prevents overwrite conflicts where introspection would replace working memory entirely, losing anything the main agent wrote between introspection cycles.

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

Memory behavior is split between:

- program-driven orchestration
- agent-generated memory content

### Program-Driven

The program decides:

- when introspection turns run
- what transcript range the introspection agent sees
- when to run compaction
- where results are stored

### Agent-Generated

The introspection agent decides:

- what to store in long-term memory
- what to update or delete from existing memory
- what to write in working memory

The main agent can also use memory tools directly during conversation.

This keeps memory behavior predictable while using the model for quality judgments.

## Compaction

Compaction is a runtime context-management mechanism, not a memory layer.

Its purpose is:

- keep long-running sessions usable
- reduce context size when a session approaches model limits
- preserve the most relevant recent turns while compressing older material

Compaction should:

- operate on session history
- be triggered by context-window pressure rather than by normal memory cadence
- not replace long-term memory or working memory

## Summary

- session log = raw factual history
- working memory = active session state (maintained by introspection + agent tool)
- long-term memory = durable knowledge via MemoryProvider (maintained by introspection + agent tools)
- user-authored knowledge = external files, not system memory
- introspection = periodic program-triggered agent turn with memory tools
- compaction = mechanical context trimming, no memory writes
- introspection runs more frequently than compaction, always on raw data
