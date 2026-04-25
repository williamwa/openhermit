# Introspection Design

Introspection is a program-triggered agent turn that maintains memory and session metadata. It is separate from context compaction.

## Purpose

Introspection keeps three pieces of state current:

- long-term memory in `memories`
- session working memory on `sessions`
- session description on `sessions`

It gives resumed sessions continuity without replaying the full transcript and catches useful facts the main agent did not explicitly store during normal conversation.

## Triggering

`AgentRunner` triggers checkpoints:

- manually through `/checkpoint`
- when a channel starts `/new`
- after `memory.introspection.turn_interval` completed turns
- after `memory.introspection.idle_timeout_minutes` of inactivity

Config:

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

## Introspection Agent

The introspection agent sees:

- transcript events since the last introspection event
- previous working memory
- current session description
- memory store access

It has a narrow toolset:

- `memory_recall`
- `memory_add`
- `memory_update`
- `memory_delete`
- `working_memory_update`
- `session_description_update`

It does not receive exec, web, instruction, user, session, schedule, or MCP tools.

## Event Cursor

The message store records introspection start/end events. `getLastIntrospectionEventId()` acts as the cursor. If introspection fails before writing the end event, the next checkpoint retries the same unsummarized history range.

## Compaction Boundary

Compaction solves context size. Introspection solves memory maintenance. Introspection runs on raw event history since the last introspection, not on compaction summaries. Compaction can then compress old prompt context without being the only memory path.

## Prompt Outcome

The introspection prompt asks the agent to:

1. decide whether any durable long-term memory should be added, updated, or deleted
2. refresh working memory only when the active task/session state changed
3. update the session description when there is a better concise label
4. do nothing if nothing is worth storing

The final introspection event records a concise summary of what changed.
