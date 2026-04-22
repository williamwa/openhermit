# Pending Decisions

Open questions and issues that need discussion before implementation.

## ~~1. Introspection Model Quality~~ — REMOVED

No longer relevant — introspection now uses capable models.

## 2. ~~memory_recall Search Quality~~ — RESOLVED

**Resolution:** Memory search now uses PostgreSQL `tsvector` + GIN index for full-text search with stemming and relevance ranking. The old SQLite implementation used naive `LIKE '%query%'` matching which required the exact substring in sequence. The PostgreSQL implementation tokenizes queries, matches via `tsvector` with stemming, and ranks by relevance. The search index is auto-maintained by a generated stored column.

## 3. Introspection vs Per-Turn Memory (Letta/ChatGPT Pattern)

**Context:** Most agent products (Letta, ChatGPT) let the agent write memories during normal conversation turns, not in a separate introspection step. Our current design uses periodic introspection as the primary reliable path, with main-agent memory tools as an optional fast path.

**Question:** Should we also encourage the main agent to write memories per-turn (like ChatGPT's bio tool)? Or is periodic introspection sufficient?

**Trade-offs:**
- Per-turn: more responsive, captures intent in the moment, but consumes tokens every turn
- Periodic introspection: batched, cheaper, but may miss nuance or misinterpret context after the fact
- Both: redundant writes possible, but the combination covers each other's weaknesses

## 4. Pipeline-Based Memory Extraction (Mem0 Pattern)

**Context:** Mem0 and Zep use program-driven pipelines to extract facts from conversations. The pipeline is deterministic and doesn't depend on model prompt-following ability.

**Question:** Should we add a lightweight extraction pipeline alongside or instead of agent-driven introspection? This could be:
- A structured prompt that outputs JSON (like the old checkpoint system but better structured)
- A classification step: "does this conversation contain any user preferences, project decisions, or environmental facts?" → if no, skip entirely
- A rule-based pre-filter that identifies candidate facts before sending to LLM

**Trade-off:** Pipeline is more predictable but less contextually intelligent than agent-driven. Could be a good complement — pipeline for reliability, agent tools for nuance.

## 5. Introspection Visibility to Main Agent

**Current design:** Introspection events (start/end + tool calls) are written to session_events and visible in the main agent's timeline.

**Question:** Is the full trace (every tool_call/tool_result) too verbose? Should we collapse old introspection spans into a single summary line? The design doc mentions this possibility but we haven't decided on the threshold.

**Related:** How should introspection events appear after compaction? Currently they would be part of the compaction summary. Is that sufficient?

## 6. ~~Working Memory Ownership~~ — RESOLVED

**Resolution:** `working_memory_update` is now exclusive to the introspection agent. The main agent no longer has access to this tool. This eliminates the overwrite conflict where introspection would replace working memory entirely, losing anything the main agent wrote between cycles. The introspection agent's prompt now explicitly states it is the sole owner of working memory.

## 7. Introspection Trigger Tuning

**Current defaults:** `turn_interval: 5`, `idle_timeout_minutes: 10`

**Questions:**
- Is 5 turns too frequent or too infrequent? Claude Code does auto-memory every ~5K tokens (~3 tool calls). We do it every 5 completed runs which could be much more content.
- Should the turn interval be token-based rather than turn-based? A turn with a massive tool result is very different from a turn with a short chat message.
- Should introspection be skipped if the conversation was trivial? (e.g., user only said "hi" and agent responded with a greeting)

## 8. ~~Legacy Checkpoint Removal Timeline~~ — RESOLVED

**Resolution:** Legacy checkpoint code has been fully removed. All legacy methods (`runLegacyCheckpoint`, `generateCheckpointArtifacts`, `runInternalCheckpointTurn`, `parseInternalCheckpointResponse`, `createFallbackCheckpointSummary`, `createFallbackSessionWorkingMemory`, etc.) and external hooks (`checkpointSummaryGenerator`, `sessionWorkingMemoryGenerator`) have been deleted. The `episodic_checkpoints` table was already dropped in v12 migration. `runSessionCheckpoint` now always uses introspection.

## 9. ~~Session Description After Introspection~~ — RESOLVED

**Resolution:** Option A implemented. The introspection agent now has a `session_description_update` tool. The per-turn AI description generation from the main agent has been removed. Fallback description (from user's first message) is still created immediately. The introspection agent updates it to an AI-quality title when it has enough context.

## 10. Letta Sleep-Time Agent Pattern

**Context:** Letta's sleep-time agents run asynchronously in the background during idle periods to reorganize and refine memory. This is similar to our idle-triggered introspection but doesn't block or appear in the session timeline.

**Question:** Should our introspection be a background process that doesn't write events to the session timeline? Or is timeline visibility important for the main agent's awareness?

**Trade-off:** Background processing is cleaner (no timeline noise) but the main agent won't know memory was updated. Timeline visibility prevents redundant memory writes but adds noise.
