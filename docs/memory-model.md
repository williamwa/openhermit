# Memory Model

This document defines the intended boundary between session logs, episodic memory, working memory, and long-term memory.

The goal is simple:

- avoid storing the same information in multiple places without a clear reason
- make memory retrieval predictable
- keep the agent's prompt context small and high-signal
- preserve a clean separation between raw logs and durable knowledge

## Overview

CloudMind uses four distinct layers:

| Layer | Location | Purpose | Retention Shape |
| --- | --- | --- | --- |
| Session Log | `sessions/*.jsonl` | Raw per-session record | Append-only, one file per session |
| Episodic Memory | `memory/episodic/*.jsonl` | Cross-session experience log | Append-only, grouped by month |
| Working Memory | `memory/working.md` | Small current-context summary | Overwritten and curated |
| Long-Term Memory | `memory/long-term.md` + `memory/notes/*.md` | Stable reusable knowledge | Indexed markdown files by topic |

These layers are not interchangeable. Each one exists for a different reason.

## 1. Session Log

Location:

- `sessions/{YYYY-MM-DD}-{session-id}.jsonl`

Purpose:

- Preserve the full factual record of one session.
- Support debugging, auditing, replay, and future session restoration.
- Act as the source of truth for what happened in a specific conversation.

Typical contents:

- session start and end markers
- inbound user messages
- assistant messages
- tool requests
- tool starts
- tool results
- approval requests and resolutions
- error events
- usage and cost summaries

What it is not:

- It is not a memory layer to inject directly into every future turn.
- It is not optimized for retrieval quality.
- It is not a durable knowledge base.

Rule:

- Session logs should be complete and factual.
- If something happened in a session, it belongs here first.

## 2. Episodic Memory

Location:

- `memory/episodic/{YYYY-MM}.jsonl`

Purpose:

- Capture experience that may matter across sessions.
- Provide a compact historical layer that is cheaper to scan than raw session logs.
- Record outcomes, failures, decisions, and preferences that are worth remembering.

Typical contents:

- session-level summaries
- long-session checkpoint summaries
- important tool outcomes
- major failures or recoveries
- user preferences that were clearly expressed
- significant environment or service changes
- memory note updates
- usage or cost summaries

What it is not:

- It is not a second copy of the full session log.
- It should not mirror every single tool event by default.
- It should not contain token-by-token or step-by-step replay detail unless the event is unusually important.

Rule:

- Episodic memory should store only events with future retrieval value.
- If an event would not help a later session, it probably should stay only in `sessions/`.
- The default summarization cadence is:
  - once when a session becomes idle for the configured timeout
  - once every 50 conversation turns for a long-running session

## 3. Working Memory

Location:

- `memory/working.md`

Purpose:

- Hold the small, active context the agent should keep "in mind" right now.
- Feed high-signal information into the prompt on each turn.
- Track what is currently in progress.

Typical contents:

- current goals
- active constraints
- open issues
- important recent decisions
- currently relevant service/container state
- short task-local facts

What it is not:

- It is not a running log.
- It is not a complete session summary archive.
- It is not a place for stable knowledge that should live for months.

Rule:

- Working memory should stay small, curated, and disposable.
- It should be rewritten or compacted regularly.
- If it grows without bound, it stops being working memory.

## 4. Long-Term Memory

Location:

- `memory/long-term.md`
- `memory/notes/*.md`

Purpose:

- Store stable facts and reusable knowledge.
- Preserve information that should survive many sessions and remain useful over time.
- Organize durable knowledge by topic rather than by timestamp.
- Provide a clear entry point so the agent can discover what long-term knowledge exists.

Typical contents:

- `memory/long-term.md` as the table of contents / index
- user preferences
- project conventions
- architecture notes
- service topology
- recurring operational knowledge
- confirmed facts worth reusing

What it is not:

- It is not for temporary task state.
- It is not for noisy event streams.
- It is not for every observation the agent ever makes.

Rule:

- Long-term memory should contain promoted knowledge, not raw activity.
- Promotion should be selective and conservative.
- `memory/long-term.md` should point to or summarize the topic files in `memory/notes/`.

## Promotion Flow

The intended information flow is:

1. Everything happens in a session.
2. Important events may be promoted into episodic memory.
3. Currently relevant information may be distilled into working memory.
4. Stable knowledge may be promoted into long-term notes.

In short:

- `sessions` = what happened
- `episodic` = what was worth remembering from what happened
- `working` = what matters right now
- `long-term` = what should remain true or useful over time

## Retrieval Flow

Different tasks should read different layers:

- To restore a conversation or audit behavior, read `sessions/`.
- To understand recent history across sessions, read `memory/episodic/`.
- To inject default context into the next turn, read `memory/working.md`.
- To recall durable knowledge, read `memory/long-term.md` first, then follow into `memory/notes/*.md` as needed.

The default prompt path should favor:

1. working memory
2. `memory/long-term.md`
3. episodic search when needed
4. relevant long-term notes
5. session replay only when explicitly necessary

## Examples

Example A:

- User says: "Focus on Telegram first, gateway later."
- Session log: always record it.
- Working memory: yes, if it affects the current implementation plan.
- Episodic memory: yes, if it changes ongoing project direction.
- Long-term memory: maybe, but only if it becomes a recurring product rule rather than a temporary roadmap choice.

Example B:

- Agent fixes `web_fetch` so it is GET-only and approval-safe.
- Session log: record the full execution.
- Episodic memory: record a compact summary of the design change.
- Working memory: include it only if the agent is still actively refining the tool system.
- Long-term memory: include it if it becomes part of the stable tool contract.

Example C:

- User prefers concise replies in Chinese.
- Session log: recorded when expressed.
- Episodic memory: optional.
- Working memory: maybe, if it matters immediately.
- Long-term memory: yes, this is a stable preference.

Example D:

- `redis-main` is currently running on host port `16379`.
- Session log: yes.
- Episodic memory: maybe, if the service was created or changed in an important way.
- Working memory: yes, if the current task depends on it.
- Long-term memory: only if that port mapping is intended to remain stable.

## Anti-Patterns

Avoid the following:

- copying every session event into episodic memory
- storing temporary task state in long-term notes
- turning working memory into a second event log
- using session logs as default prompt context
- promoting unverified or weakly inferred facts into long-term memory

## Implementation Guidance

For implementation purposes, the preferred defaults are:

- `sessions/` remains the complete append-only source of truth
- `memory/episodic/` stores selective summaries and important events
- `memory/working.md` is actively rewritten, not append-only
- `memory/long-term.md` is the entry point to long-term memory
- `memory/notes/*.md` is updated through normal file tools, with `file_search` used for discovery and retrieval
- no dedicated `memory_*` tools are required for v1, because memory is plain markdown/filesystem data

Suggested future automation:

- create an episodic checkpoint when a session becomes idle for a configured timeout
- create an episodic checkpoint every 50 conversation turns in long-running sessions
- periodically compact working memory
- promote stable recurring facts from episodic memory into `memory/long-term.md` and topic notes

## Status

This document describes the intended model.

The current implementation already has:

- session logs
- durable `sessions/index.json` for listing and resume metadata
- episodic logs
- working memory injection
- session descriptions for easier session recall
- plain markdown/file storage that can support long-term indexing

But the boundary between `sessions` and `episodic` is still looser than intended, and `memory/long-term.md` is not yet acting as the long-term entry point. Future memory work should move the implementation toward the model defined here.

## Prerequisites and Operational Assumptions

The memory model above depends on a few runtime assumptions:

- Starting a new session explicitly matters. In the CLI flow, `/new` should switch the local binding to a fresh session without closing or deleting the previous one.
- Session listings and explicit recovery matter. The CLI should be able to inspect prior sessions via `/sessions` and rebind via `/resume <id>` or `--resume`.
- Episodic summarization depends on reliable checkpoint triggers:
  - once when a session has been idle for the configured timeout
  - once every 50 conversation turns for a long-running session
- Long-term memory remains plain markdown. The agent should manage `memory/long-term.md` and `memory/notes/*.md` through normal file operations.
- A `file_search` tool is required so the agent can efficiently discover and retrieve relevant memory files without loading the entire workspace.
