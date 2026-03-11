# OpenHermit v2 Architecture Direction

This document defines the architectural direction for `v2`.

It is intentionally not a full rewrite of `v1`. It highlights the key boundary changes that should drive the next planning cycle.

## Core Shift

In `v1`, the agent workspace contains a mixture of:

- user/project-authored content
- runtime-managed state
- agent identity files
- memory files
- session state

In `v2`, these should be split into two clearer categories:

- `internal state`
- `external state`

## New Boundary

### Internal State

Internal state is owned by the OpenHermit program and runtime.

It is not the same as ordinary task files, and it should not be treated as part of the agent's normal working directory.

Examples:

- identity state
- session metadata and message history
- episodic checkpoints
- session-local working memory
- global working memory
- long-term system memory
- approvals and pending gates
- channel/session bindings
- schedules and schedule runs
- container runtime state

This state should be stored in a program-managed store.

### External State

External state is what the agent works on for the user.

It is the part of the world the agent should be able to read, write, search, and manipulate as part of ordinary tasks.

Examples:

- project files
- generated artifacts
- user-authored docs, prompts, or notes
- container-mounted working data
- other task-related files in the agent sandbox

This is the real "workspace" from the agent's task perspective.

## Memory Direction

### v1 Limitation

`v1` stores memory inside the workspace as markdown and JSONL files. That made the first implementation simple, but it also blurred the boundary between:

- internal runtime state
- external task files
- user-authored knowledge
- agent-managed state

### v2 Direction

Memory should move into a program-level store.

Recommended shape:

- `SessionStore`
- `MemoryStore`
- `BindingStore`
- `ScheduleStore`
- `IdentityStore`
- `ContainerRuntimeStore`

Recommended first backend:

- SQLite

Reason:

- good local-first default
- easy migration path
- strong fit for future multi-agent and gateway work

## Identity Direction

Identity should also move to the internal-state side.

However, it is useful to preserve editable user inputs that shape identity.

The recommended split is:

- `identity inputs`:
  user-authored files that express persona, role, preferences, and behavior guidance
- `identity state`:
  the normalized internal representation the runtime actually uses

This avoids conflating:

- editable configuration inputs
- canonical runtime-owned identity state

## Container Direction

Containers should be split the same way:

- `container runtime state` is internal
- `container-mounted task data` is external

### Internal container state

Examples:

- container registry
- lifecycle status
- ownership
- image
- network bindings
- restart policy
- health state

### External container state

Examples:

- mounted code
- service data directories
- build artifacts
- task inputs and outputs

This means:

- the container object belongs to internal orchestration
- the mounted data belongs to the agent's external sandbox

## Scheduler Direction

`v2` should stop treating scheduling as heartbeat-specific logic inside the agent runtime.

Instead, use a program-level scheduler that dispatches runs into agents.

The agent remains the execution engine.
The scheduler becomes the orchestration layer.

## Proposed Schedule Shape

```json
{
  "schedule_id": "daily-hn-summary",
  "enabled": true,
  "trigger": {
    "type": "cron",
    "value": "0 8 * * *",
    "timezone": "America/New_York"
  },
  "task": {
    "handler": "hackernews.summarize",
    "version": "1.0",
    "input": {
      "limit": 10,
      "min_points": 100,
      "include_comments": false
    }
  },
  "execution": {
    "timeout_sec": 120,
    "max_retries": 2,
    "retry_backoff": "exponential",
    "concurrency": "singleton"
  },
  "output": {
    "destinations": ["chat", "file://reports/hn-daily.md"]
  },
  "dependencies": ["openrouter-api-key-valid"],
  "metadata": {
    "description": "Daily HN top stories",
    "created_by": "user",
    "tags": ["news", "automation"]
  }
}
```

Supported trigger categories should include:

- `cron`
- `interval`
- `at`
- `event`
- `dependency`

## Role Of The Agent In v2

The per-agent runtime should focus on:

- model loop
- tool calling
- session execution
- approval pauses
- event streaming

It should not own:

- the primary memory lifecycle policy
- the primary scheduling/orchestration policy
- cross-agent coordination
- the primary session persistence layer
- the primary container registry or runtime inventory

## Design Goal

The long-term architecture should look like this:

- agent runtime = execution engine
- external workspace = sandboxed user/project space
- internal state store = operational state
- scheduler = run orchestration
- future gateway = multi-agent control plane over the same program store
