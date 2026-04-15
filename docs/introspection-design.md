# Introspection Design

## Overview

Introspection is the mechanism that maintains the agent's memory system. It is a periodic, program-triggered agent turn where a lightweight agent reflects on recent conversation and updates long-term memory, working memory, and session description using real tool calls.

## Why Introspection Exists

Three problems need solving:

### 1. Session resumption continuity

When the agent process restarts, LLM context is empty. Working memory and long-term memory provide compressed context that can be injected on resumption, giving the agent continuity without replaying the full transcript.

### 2. Working memory across turns

LLMs have no persistent state between turns. Introspection periodically generates a "working memory" block — current objective, open questions, next steps — that is injected into every turn's context. This keeps the agent oriented even in long sessions.

### 3. Long-term memory maintenance

The agent has memory tools during normal conversation, but using them depends on the agent choosing to call them. In practice, the agent is focused on the user's task and often forgets. Introspection is the safety net that ensures memory gets maintained even when the agent doesn't proactively use tools.

## The Introspection Agent

A lightweight agent that:

- **Sees:** recent conversation transcript since last introspection, current working memory, current session description
- **Has tools:** `memory_recall`, `memory_add`, `memory_update`, `memory_delete`, `working_memory_update`, `session_description_update`
- **Does not have:** `exec`, container tools, web tools, instruction tools
- **Goal:** reflect on recent activity, update long-term memory, working memory, and session description as needed

The prompt has three ordered steps:

1. **Step 1: Long-term memory** — Did the user reveal preferences, project decisions, or environment facts worth storing across sessions? If yes, check for existing entries and add/update. If no, skip.
2. **Step 2: Working memory** — Has the session state meaningfully changed? If yes, refresh. Focus on user intent and current task, not content they looked at.
3. **Step 3: Session description** — Is the current description missing or stale? If yes, update to a short title (under 10 words) reflecting the main topic.

The agent is explicitly told it does NOT have to update anything. If there is nothing worth storing, it should do nothing and stop. Less is more.

## Configuration

Introspection is configured in `~/.openhermit/{agent-id}/config.json` under the `memory` key:

```json
{
  "memory": {
    "introspection": {
      "enabled": true,
      "turn_interval": 5,
      "idle_timeout_minutes": 10,
      "max_tool_calls": 10,
      "model": null
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Set to `false` to disable automatic introspection entirely. Memory tools on the main agent still work — only the automatic reflection is disabled. |
| `turn_interval` | number | `5` | Run introspection every N completed runs. Set to `0` to disable turn-based triggers (idle and manual triggers still work if enabled). |
| `idle_timeout_minutes` | number | `10` | Run introspection after this many minutes of inactivity. Set to `0` to disable idle triggers. |
| `max_tool_calls` | number | `10` | Maximum tool calls the introspection agent can make per run. Bounds cost. |
| `model` | string \| null | `null` | Override model for introspection agent. `null` means use the same model as the main agent. Can be set to a cheaper model since introspection is just reflection + memory CRUD. |

When `enabled` is `false`:
- No automatic introspection runs
- No introspection events in session_events
- Working memory is only updated if the main agent calls `working_memory_update`
- Long-term memory is only updated if the main agent calls `memory_add` / `memory_update`
- Session description stays at the fallback (first user message) unless manually changed
- Compaction still works normally

## Triggers

When enabled, introspection is triggered by:

- `turn_limit` — every N completed runs (configured by `turn_interval`)
- `idle` — after idle timeout (configured by `idle_timeout_minutes`)
- `new_session` — when adapter switches sessions
- `manual` — explicit API call (`POST /sessions/:id/checkpoint`)

## Introspection Events in Session Timeline

An introspection is a **span** in the session event timeline:

1. **`introspection_start`** — written when introspection begins
2. **`tool_call` / `tool_result`** — each tool call the introspection agent makes
3. **`introspection_end`** — written when introspection completes, with a summary of changes

Example timeline in `session_events`:

```
[INTROSPECTION_START] reason: turn_limit, turns_since_last: 5
[TOOL_CALL] memory_recall("user architecture preferences")
[TOOL_RESULT] memory_recall: Found 2 entries — mem-a1, mem-b2
[TOOL_CALL] memory_update("mem-a1", content: "user prefers container-native...")
[TOOL_RESULT] memory_update: Updated.
[TOOL_CALL] working_memory_update("## Current task\nImplementing web provider...")
[TOOL_RESULT] working_memory_update: Working memory updated.
[TOOL_CALL] session_description_update("Web provider abstraction design")
[TOOL_RESULT] session_description_update: Session description updated.
[INTROSPECTION_END] updated 1 memory(s), refreshed working memory, updated session description
```

The main agent sees the full introspection trace in its context on subsequent turns. This gives it:
- **Transparency** — exactly what the introspection did, not a lossy summary
- **Deduplication signal** — the agent can see that specific memories were already saved and avoid redundant writes
- **Working memory awareness** — the agent knows its scratchpad was just refreshed

## Cost Control

The introspection agent is a multi-turn agent loop (it calls tools), not a single LLM call. To bound cost:

- **Max tool calls:** capped at a configurable limit (default: 10). After this many tool calls the agent is aborted.
- **Model choice:** the introspection agent can use a cheaper model via the `model` config. Since it's just reflection and memory CRUD, a smaller model usually suffices.
- **History window:** only the transcript since last introspection is provided, not the full session history.

## Relationship to Compaction

| | Compaction | Introspection |
|-|-----------|---------------|
| **Purpose** | Keep context within model limits | Maintain agent's memory system |
| **Trigger** | Token budget exceeded | Every N turns / idle / manual |
| **Writes to** | session_events (compaction summary) | Long-term memory + working memory + session description + session_events |
| **Intelligence** | Summarization only | Full memory CRUD with reasoning |
| **Cost** | One LLM call | Multi-turn agent loop (bounded) |

They are complementary and independent. Compaction solves a mechanical problem (context overflow). Introspection solves a cognitive problem (memory maintenance). They are not coupled.

### Introspection Runs More Frequently Than Compaction

This is a key design invariant. Introspection should always run on raw, uncompressed conversation data — never on compaction summaries. If introspection is frequent enough, by the time compaction triggers, all important information has already been extracted into long-term memory and working memory.

```
conversation turns:  1  2  3  4  5  6  7  8  9  10  11  12 ...
introspection:             *           *            *
compaction:                                              *  (token pressure)
```

This means:
- Introspection always sees full-fidelity messages, not lossy summaries
- Compaction can safely compress old context because memory is already up to date
- No need for a "pre-compaction memory pass" — introspection has already done the work
- The two systems remain completely independent: different triggers, different purposes, no sequencing dependencies

## Memory Write Paths

Memory is updated through two paths:

### 1. Introspection (automatic)

The reliable, periodic path. Even if the agent never calls memory tools during conversation, introspection will periodically reflect and persist what matters.

### 2. Explicit agent tool use

If the user directly says "remember this", the main agent can update long-term memory immediately using `memory_add` or `memory_update`. This path is responsive but not reliable — the agent may forget to use it.

## Session Description

Session descriptions (titles shown in session lists) are maintained through two mechanisms:

1. **Fallback description** — created immediately from the user's first message. Simple text truncation, no LLM call.
2. **Introspection** — the introspection agent has a `session_description_update` tool to set a more meaningful title once it has enough conversation context.

This replaces the previous per-turn AI description generation, which made a separate LLM call after each turn with limited context (just the latest user/assistant pair). The introspection agent sees the full transcript since last introspection and can produce a better title.

## Dynamic System Prompt

The system prompt is dynamically assembled based on which tools are available to the agent. Each section (memory, containers, execution, web, instructions) is only included when the corresponding tools are present. This avoids confusing the agent with instructions for tools it cannot use and keeps the prompt concise.

## Implementation

### Introspection Agent Creation

Reuses `createConfiguredAgent()` with:
- A specific tool set (memory tools + `working_memory_update` + `session_description_update`)
- An introspection-specific system prompt
- A langfuse request tagged as `openhermit.session_introspection`
- Max tool call limit to bound cost

### History Input

The introspection agent receives:
- Formatted transcript since last introspection
- Current working memory content
- Current session description
- How many turns have elapsed and why introspection was triggered

### Event Recording

Events are written to `session_events` in real time as the introspection agent runs:

1. **Before agent starts:** write `introspection_start` event with reason and turn count
2. **During agent loop:** each tool call and tool result is written as events (with `introspection: true` marker)
3. **After agent completes:** write `introspection_end` event with a summary of changes (memories added/updated/deleted, working memory refreshed, description updated)
4. If description was updated by introspection, sync it back to the runner session

### Failure Handling

If the introspection agent fails (API error, timeout, etc.):
- Log the failure
- The `introspection_end` event is not written, so `getLastIntrospectionEventId()` returns the previous cursor — next introspection will naturally retry with the same history range
