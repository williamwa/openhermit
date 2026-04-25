# Pending Decisions

Open questions and issues that need discussion before implementation.

## Open

### 1. Introspection vs Per-Turn Memory (Letta/ChatGPT Pattern)

**Context:** Most agent products (Letta, ChatGPT) let the agent write memories during normal conversation turns, not in a separate introspection step. Our current design uses periodic introspection as the primary reliable path, with main-agent memory tools as an optional fast path.

**Question:** Should we also encourage the main agent to write memories per-turn (like ChatGPT's bio tool)? Or is periodic introspection sufficient?

**Trade-offs:**
- Per-turn: more responsive, captures intent in the moment, but consumes tokens every turn
- Periodic introspection: batched, cheaper, but may miss nuance or misinterpret context after the fact
- Both: redundant writes possible, but the combination covers each other's weaknesses

### 2. Pipeline-Based Memory Extraction (Mem0 Pattern)

**Context:** Mem0 and Zep use program-driven pipelines to extract facts from conversations. The pipeline is deterministic and doesn't depend on model prompt-following ability.

**Question:** Should we add a lightweight extraction pipeline alongside or instead of agent-driven introspection?

**Trade-off:** Pipeline is more predictable but less contextually intelligent than agent-driven. Could be a good complement — pipeline for reliability, agent tools for nuance.

### 3. Introspection Visibility to Main Agent

**Current design:** Introspection events (start/end + tool calls) are written to session_events and visible in the main agent's timeline.

**Question:** Is the full trace (every tool_call/tool_result) too verbose? Should we collapse old introspection spans into a single summary line?

**Related:** How should introspection events appear after compaction? Currently they would be part of the compaction summary.

### 4. Introspection Trigger Tuning

**Current defaults:** `turn_interval: 5`, `idle_timeout_minutes: 10`

**Questions:**
- Is 5 turns too frequent or too infrequent?
- Should the turn interval be token-based rather than turn-based?
- Should introspection be skipped if the conversation was trivial?

### 5. Letta Sleep-Time Agent Pattern

**Context:** Letta's sleep-time agents run asynchronously in the background during idle periods to reorganize and refine memory.

**Question:** Should our introspection be a background process that doesn't write events to the session timeline? Or is timeline visibility important for the main agent's awareness?

**Trade-off:** Background processing is cleaner (no timeline noise) but the main agent won't know memory was updated. Timeline visibility prevents redundant memory writes but adds noise.

## Resolved

1. ~~Introspection Model Quality~~ — no longer relevant, introspection now uses capable models.
2. ~~memory_recall Search Quality~~ — PostgreSQL `tsvector` + GIN index with full-text search and BM25-style ranking.
3. ~~Working Memory Ownership~~ — `working_memory_update` now exclusive to introspection agent.
4. ~~Legacy Checkpoint Removal~~ — fully removed, `episodic_checkpoints` table dropped.
5. ~~Session Description After Introspection~~ — introspection agent has `session_description_update` tool.
