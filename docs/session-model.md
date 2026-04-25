# OpenHermit Session Model

This document defines how OpenHermit treats sessions, runs, adapter bindings, and control commands such as `/new`.

## Core Principles

- the agent core only knows `sessionId`
- sessions are durable threads
- a session does not have a permanent `closed` state
- any previous session may be resumed later
- adapter binding decides which session a user is currently talking to

## Key Concepts

## 1. Session

A session is a durable conversation thread.

Properties:

- identified by `sessionId`
- owns its message history
- owns its event history
- may be revisited later
- may accumulate multiple introspection events over time

Session persistence now lives in PostgreSQL (scoped by `agent_id`).

## 2. Run

A run is one active execution period on a session.

Examples:

- a user sends a message and the agent responds
- the agent pauses for approval
- a scheduled trigger posts a message into a session

Runs are temporary. Sessions are durable.

For introspection interval accounting, one completed run counts as one completed turn.
That turn boundary is the runtime-level execution window from `agent_start` to `agent_end`,
even if the run contains multiple internal assistant messages, tool calls, or LLM steps.

Runtime execution states:

- `idle`
- `running`
- `awaiting_approval`
- `inactive` — session is no longer actively managed in memory (e.g. replaced by `/new`)

These are runtime states, not permanent session states. An `inactive` session can still be resumed later.

## 3. Adapter Binding

An adapter binding is the mapping from a user/channel context to the session currently being used.

Examples:

- CLI process -> current session ID
- web client -> current session ID
- Telegram chat ID -> current session ID

This binding belongs to the adapter layer, not the agent core.

## No Closed Session State

Sessions should not be permanently closed.

Reasons:

- a user may want to revisit an older topic later
- summarization should not depend on irreversible closure
- adapter rebinding is enough for conversation switching

Instead:

- sessions remain addressable indefinitely
- adapters may stop actively binding to a session
- memory is maintained via introspection

## Cross-Channel `/new`

`/new` is not a CLI-only command.

It is a channel-agnostic control message that should work consistently across interactive adapters.

Meaning:

- stop using the adapter's current bound session
- create a new session ID
- rebind the current user/channel context to that new session
- continue future messages in the new session

`/new` does not close, archive, or delete the previous session.

## Session Resume

Resuming an old session should be explicit.

Recommended behaviors:

- no current binding -> start a new session
- existing binding -> continue the bound session
- explicit resume action -> switch back to some older session

Examples:

- CLI: `--session <id>` or `/resume <id>`
- future IM adapters: `/resume <id>`
- web: explicit session selection in the UI

## Listing Sessions

Agent-local API:

- `GET /sessions`

This returns sessions known to one agent, not a global cross-agent view.

Recommended filters:

- `kind`
- `platform`
- `interactive`
- `limit`

Recommended default sort:

- `lastActivityAt desc`

Typical fields:

- `sessionId`
- `source`
- `createdAt`
- `lastActivityAt`
- `lastEventId`
- `messageCount`
- `description`
- `lastMessagePreview`
- `status`

## Session History

Agent-local API:

- `GET /sessions/{sessionId}/messages`

This reads session history from internal state and returns message history in reverse chronological order.

## Session Events

Agent-local API:

- `GET /sessions/{sessionId}/events`

This streams new events for the session over SSE.

## Introspection

Agent-local API:

- `POST /sessions/{sessionId}/checkpoint`

Introspection is a program-driven memory maintenance turn. A lightweight agent with memory tools reflects on recent conversation and updates long-term memory and working memory.

Typical triggers:

- explicit request
- adapter switching to a new session
- configured turn interval
- idle timeout

See `docs/introspection-design.md` and `docs/memory-model.md` for details.

## Current Client Behavior

### CLI

- default: new session
- `--resume`: resume the most recent CLI session
- `--session <id>`: bind to a specific session
- `/new`: switch to a fresh session
- `/sessions`: list recent sessions
- `/resume <id>`: switch to an existing session

### Web

- shows session list
- allows session selection
- allows creating a new session
- streams the current session through SSE

## Group Sessions

Group chat sessions (from Telegram groups, Discord channels, Slack channels) follow specific routing rules:

- **All messages stored** — every message from every user is recorded in the session log, regardless of whether it triggers the agent
- **Owner messages** — always trigger agent response (with mention status as context)
- **Non-owner, mentioned** — triggers agent response
- **Non-owner, not mentioned** — stored only, agent is not triggered (saves tokens)
- **`<NO_REPLY>`** — even when triggered, the agent may respond with `<NO_REPLY>` to decline replying; this is silently discarded by all channel adapters

In group sessions, user messages are prefixed with the sender's display name: `[Alice] hello`. Non-mentioned messages add: `[Alice] [not directed at you] hello`.

See [Channel Adapter Design](channel-adapter.md) for full details.

## Summary

- session = durable thread
- run = active execution on a session
- adapter binding = which session a client is currently using
- `/new` = rebind to a fresh session, not close the old one
