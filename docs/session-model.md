# Session Model

This document defines how CloudMind treats sessions, active runs, adapter bindings, and cross-channel control commands such as `/new`.

The main design goal is to keep the agent core session model simple:

- the agent core is not stateful in terms of "current conversation"
- every session is a first-class thread identified only by `sessionId`
- channels and adapters are responsible for deciding which session a user is currently talking to

## Core Principles

- The agent core only knows `sessionId`.
- Sessions are persistent threads, not temporary execution handles.
- A session does not have a terminal `closed` state.
- Any old session may be resumed later by sending another message to the same `sessionId`.
- Session switching is an adapter concern, not an agent-core concern.

## Key Concepts

### 1. Session

A session is a durable conversation thread.

Properties:

- identified by `sessionId`
- owns its message history and session log
- may be revisited later
- may accumulate multiple summaries over time

A session is not "the current chat" globally. It is just one thread among many.

### 2. Run

A run is one active execution period on a session.

Examples:

- user sends a message and the agent responds
- the agent pauses for approval
- a scheduled trigger posts a message into an existing session

Runs are temporary. Sessions are durable.

Recommended runtime execution states:

- `idle`
- `running`
- `awaiting_approval`

These are execution states, not permanent session states.

### 3. Adapter Binding

An adapter binding is the mapping from a user/channel context to the session currently being used.

Examples:

- CLI process -> current session ID
- Telegram chat ID -> current session ID
- future web UI tab or thread -> current session ID

This binding belongs to the adapter layer, not the agent core.

## No Closed Session State

CloudMind should not treat sessions as permanently closed.

Reasons:

- a user may want to return to an older topic later
- a Telegram user may revisit a previous conversation thread
- summarization should not depend on a hard terminal state
- permanent close/reopen semantics add complexity without helping the core model

Instead:

- sessions remain addressable indefinitely
- adapters may stop actively binding to a session
- summarization happens through checkpoints, not through irreversible closure

## Cross-Channel `/new`

`/new` is not a CLI-only command.

It is a channel-agnostic control message that should work consistently across interactive adapters:

- CLI
- Telegram
- future Discord / Feishu / web UI

Semantic meaning of `/new`:

- stop using the adapter's current bound session
- create a new session ID
- rebind the current user/channel context to the new session
- send future normal messages to the new session

`/new` does not delete, archive, or close the previous session.

It only changes the adapter binding.

## Session Resume

Resuming an old session should be explicit.

The agent core does not track "last session" or "current session" globally.

Recommended behavior:

- if an adapter has no current binding, it starts a new session
- if an adapter already has a current binding, normal messages continue in that bound session
- returning to some older session should require an explicit adapter action, such as:
  - `--session <id>` in CLI
  - future `/resume <id>` in IM channels
  - future UI thread selection

## Adapter Responsibilities

Interactive adapters should manage:

- the current binding from user/chat context to `sessionId`
- recognition of control messages like `/new`
- explicit resume or session-switch UX
- presentation of agent events and approvals

The agent core should manage only:

- accepting `sessionId`
- processing messages
- writing logs
- running tools
- producing events

## Session Listing

The agent-local API should expose a session listing endpoint:

- `GET /sessions`

This endpoint lists sessions known to the current agent.

It does not mean "all sessions for the current user" in a global product sense, because the agent core does not own a universal user identity model. Instead, it returns the sessions visible to this agent and lets callers filter them by source metadata.

Recommended query parameters:

- `kind`
- `platform`
- `interactive`
- `limit`

Possible future filters:

- `triggerId`
- adapter-specific metadata fields

Recommended default ordering:

- `lastActivityAt desc`

Recommended response fields:

- `sessionId`
- `source`
- `createdAt`
- `lastActivityAt`
- `messageCount`
- `lastMessagePreview`
- runtime execution `status` such as `idle | running | awaiting_approval`

This endpoint exists for:

- CLI resume workflows
- Telegram or other IM adapter session switching
- future UI thread lists
- summarization and idle-checkpoint scheduling

## Summarization Model

Because sessions are not permanently closed, memory updates should use checkpoints instead of final-close semantics.

Recommended checkpoint triggers:

- when a session is idle for a configurable timeout
- every 50 conversation turns in a long-running session

These checkpoints should write summarized memory artifacts, for example:

- episodic `session_checkpoint` entries
- working memory refreshes when relevant
- long-term memory promotions when stable facts emerge

## Relationship to Memory

This model aligns with the memory design:

- `sessions/*.jsonl` stores the full per-session source of truth
- `memory/episodic/*.jsonl` stores summarized cross-session checkpoints
- `memory/working.md` stores current high-signal context
- `memory/long-term.md` and `memory/notes/*.md` store durable knowledge

Checkpoint summarization is therefore:

- session-aware
- not dependent on hard closure
- reusable across CLI, Telegram, and future adapters

## Recommended Initial Implementation

For v1, the simplest consistent behavior is:

1. Agent core remains session-ID based only.
2. CLI keeps a current in-process binding to one session.
3. `/new` switches the CLI binding to a fresh session.
4. Future Telegram bridge uses the same rule for each chat.
5. Older sessions remain resumable through explicit selection.
6. Checkpoint summarization is triggered by idle timeout and every 50 turns.

## Status

This document defines the intended direction.

Current implementation already has explicit `sessionId` in the core API, which matches this design. The remaining work is primarily in adapter behavior, checkpoint summarization, and file search support.
