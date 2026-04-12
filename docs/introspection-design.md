# Introspection: Redesigning the Checkpoint System

## Problem

The current checkpoint system has two limitations:

1. **It generates structured JSON, not tool calls.** The checkpoint agent is told to "return JSON only with keys summary and sessionWorkingMemory". It writes to two fixed outputs (episodic_checkpoints row + sessions.working_memory) through program logic, not through the memory system itself. This means checkpoint memory writes bypass the regular MemoryProvider entirely.

2. **Long-term memory has no reliable maintenance path.** The agent has memory tools (memory_add, memory_update, etc.), but using them depends on the agent choosing to call them during normal conversation. In practice, the agent is focused on the user's task and often forgets. Long-term memory either grows stale or never gets written at all.

The result: two disconnected memory write paths (checkpoint outputs vs memory tools), and neither is fully reliable for long-term memory.

## Why Checkpoints Were Added

The checkpoint system was introduced to solve three problems:

### 1. Session resumption continuity

When the agent process restarts, LLM context is empty. Checkpoints generate episodic summaries that can be loaded on resumption, giving the agent a compressed history without replaying the full transcript.

### 2. Working memory across turns

LLMs have no persistent state between turns. Checkpoints periodically generate a "working memory" block — current objective, open questions, next steps — that is injected into every turn's context. This keeps the agent oriented even in long sessions.

### 3. Episodic memory indexing

Each checkpoint produces a summary stored in `episodic_checkpoints`. These summaries serve as a searchable index of what happened in each session, bridging raw session logs and higher-level memory.

All three are valid needs. The issue is the mechanism: a single-shot LLM call that outputs JSON, writes to two custom tables, and has no access to the memory system it's supposed to maintain.

## Proposed Design: Introspection Turn

Rename "checkpoint" to "introspection" to reflect the broader role: not just summarizing, but actively maintaining the agent's memory system.

### Core Change

Replace the current flow:

```
Trigger → LLM call → parse JSON → write episodic_checkpoints + sessions.working_memory
```

With:

```
Trigger → lightweight agent loop with memory tools → agent reads/writes memory → introspection event logged
```

### The Introspection Agent

A lightweight agent that:

- **Sees:** recent conversation history since last introspection, current working memory
- **Has tools:** memory_recall, memory_add, memory_update, memory_delete, working_memory_update
- **Does not have:** exec, container tools, web tools, instruction tools
- **Goal:** reflect on recent activity, update long-term memory and working memory

The prompt tells it:

> This is an introspection turn, not a user-facing reply.
> Review the conversation activity since your last introspection.
> Your goals:
> 1. Update long-term memory — use memory_recall to check what exists, then memory_add or memory_update as needed. Only store information with durable value across sessions.
> 2. Update working memory — use working_memory_update to refresh the session scratchpad with current state: objectives, decisions, open questions, next steps.
> Do not duplicate information that is already in memory. Do not store trivial or ephemeral details.

### Configuration

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
| `model` | string \| null | `null` | Override model for introspection agent. `null` means use the same model as the main agent. Can be set to a cheaper model (e.g. haiku) since introspection is just reflection + memory CRUD. |

When `enabled` is `false`:
- No automatic introspection runs
- No introspection events in session_events
- Working memory is only updated if the main agent calls `working_memory_update`
- Long-term memory is only updated if the main agent calls `memory_add` / `memory_update`
- Compaction still works normally

This is useful for cost-sensitive deployments, debugging, or agents that don't need persistent memory.

### Triggers

When enabled, introspection is triggered by:

- `turn_limit` — every N completed runs (configured by `turn_interval`)
- `idle` — after idle timeout (configured by `idle_timeout_minutes`)
- `new_session` — when adapter switches sessions
- `manual` — explicit API call (`POST /sessions/:id/checkpoint`)

### Introspection Events in Session Timeline

An introspection is a **span** in the session event timeline, not a single summary event. The runtime records the full trace of what the introspection agent did:

1. **`introspection_start`** — written when introspection begins
2. **`tool_call` / `tool_result`** — each tool call the introspection agent makes (memory_recall, memory_add, working_memory_update, etc.)
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
[INTROSPECTION_END] Updated 1 memory. Working memory refreshed.
```

The main agent sees the full introspection trace in its context on subsequent turns. This gives it:
- **Transparency** — exactly what the introspection did, not a lossy summary
- **Deduplication signal** — the agent can see that specific memories were already saved and avoid redundant writes
- **Working memory awareness** — the agent knows its scratchpad was just refreshed

On session resumption, introspection events load as part of "entries since last compaction". The resumed agent sees the full introspection history, maintaining continuity.

For context window efficiency, `formatSessionEntry` can render the introspection span in a compact form when the introspection is old (e.g., collapse tool_call/tool_result pairs into a single line summary), while keeping recent introspections fully expanded.

### Cost Control

The introspection agent is a multi-turn agent loop (it calls tools), not a single LLM call. To bound cost:

- **Max tool calls:** cap at a configurable limit (default: 10). After this many tool calls the agent must stop.
- **Model choice:** the introspection agent can use the same model as the main agent, or a cheaper model via separate config. Since it's just reflection and memory CRUD, a smaller model usually suffices.
- **History window:** only the transcript since last introspection is provided, not the full session history.

### What Gets Retired

| Current | After |
|---------|-------|
| `episodic_checkpoints` table | Replaced by long-term memory entries written by introspection agent. The introspection event in session_events serves as the timeline marker. |
| JSON parsing of checkpoint output | Eliminated. The agent uses tools directly. |
| `generateCheckpointArtifacts()` | Replaced by introspection agent loop. |
| `runInternalCheckpointTurn()` | Replaced by introspection agent loop. |
| `parseInternalCheckpointResponse()` | Eliminated. |
| `createFallbackCheckpointSummary()` | Eliminated or kept as a minimal fallback if introspection agent fails. |
| `createFallbackSessionWorkingMemory()` | Eliminated. |
| Custom checkpoint summary generators | Evaluate whether still needed. |

### What Stays

| Component | Status |
|-----------|--------|
| Trigger logic (turn_limit, idle, manual, new_session) | Kept as-is |
| `sessions.working_memory` storage + injection | Kept — introspection writes via `working_memory_update` tool |
| Memory tools on main agent | Kept — still available for explicit use during conversation |
| Compaction | Unchanged — purely mechanical context trimming |
| Session description generation | Kept — can still be derived after introspection completes |

## Relationship to Other Memory Mechanisms

### Compaction vs Introspection

| | Compaction | Introspection |
|-|-----------|---------------|
| **Purpose** | Keep context within model limits | Maintain agent's memory system |
| **Trigger** | Token budget exceeded | Every N turns / idle / manual |
| **Writes to** | session_events (compaction summary) | Long-term memory + working memory + session_events (introspection events) |
| **Intelligence** | Summarization only | Full memory CRUD with reasoning |
| **Cost** | One LLM call | Multi-turn agent loop (bounded) |

They are complementary and independent. Compaction solves a mechanical problem (context overflow). Introspection solves a cognitive problem (memory maintenance). They should not be coupled.

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

The default `memory.checkpoint_turn_interval` should be tuned so that introspection fires well before context pressure builds. For typical usage, every 3-5 turns is a reasonable starting point (compared to compaction which may not fire until 20+ turns on large context models).

### Memory Tools on Main Agent vs Introspection

The main agent still has memory tools. Two write paths:

1. **Explicit user instruction** — user says "remember this", agent calls memory_add immediately. This is synchronous and user-driven.
2. **Introspection** — periodic automatic reflection. This is the safety net that ensures memory gets maintained even when the agent doesn't proactively use tools.

These are not redundant. Path 1 is responsive. Path 2 is reliable.

## Implementation Considerations

### Introspection Agent Creation

Reuse `createConfiguredAgent()` but with:
- A specific tool set (memory tools + working_memory_update only)
- An introspection-specific system prompt
- A langfuse request tagged as `openhermit.session_introspection`
- Max turn limit to bound cost

### History Input

The introspection agent receives:
- Formatted transcript since last introspection (same format as session resumption entries)
- Current working memory content
- A note about how many turns have elapsed and why introspection was triggered

### Event Recording

Events are written to `session_events` in real time as the introspection agent runs:

1. **Before agent starts:** write `introspection_start` event with reason and turn count
2. **During agent loop:** each tool call and tool result is written as `tool_call` / `tool_result` events (same format as main agent tool events, but within the introspection span)
3. **After agent completes:** write `introspection_end` event with a summary of changes (memories added/updated/deleted, working memory refreshed or not)
4. Update session index (lastSummarizedHistoryCount, lastSummarizedTurnCount, etc.)

### Failure Handling

If the introspection agent fails (API error, timeout, etc.):
- Log the failure
- Do not update lastSummarizedHistoryCount — next introspection will retry with the same history range
- Optionally fall back to a simple working memory template (current fallback behavior)
