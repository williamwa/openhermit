# OpenHermit Architecture Decisions

## ADR-000: OpenHermit prioritizes sandboxing, hosted multi-agent use, and clear interfaces

**Decision**: The project should optimize for three top-level goals from the beginning:

- stronger safety through sandboxed execution
- future multi-user and multi-agent deployment
- strict boundaries between major components

**Rationale**:

- isolated execution is a core answer to the safety problems seen in more host-trusting agent systems
- the system should grow toward platform deployment, not only personal self-hosting
- separate components with explicit interfaces are easier to reason about than one large mixed package

## ADR-001: Agent runs on host, containers are tools

**Decision**: The agent process runs on the host. Containers are sandboxed workers and services controlled by the agent.

**Rationale**:

- persistent runtime state belongs on the host
- the agent must manage containers directly
- the trust boundary stays clear

## ADR-002: Internal state is outside the workspace

**Decision**: Internal runtime state must not live in the agent workspace by default.

**Current internal location**:

- `~/.openhermit/{agent-id}/state.sqlite`
- `~/.openhermit/{agent-id}/runtime.json`
- `~/.openhermit/{agent-id}/security.json`
- `~/.openhermit/{agent-id}/secrets.json`

**Rationale**:

- internal state is runtime-owned, not ordinary task data
- the workspace should remain the agent's external sandbox
- this prevents the workspace from mixing user files with runtime truth

## ADR-003: Workspace is external state

**Decision**: The workspace should contain only external task state and user-authored inputs.

Examples:

- project files
- artifacts
- user-authored docs and prompts
- identity inputs
- container-mounted task data

**Rationale**:

- cleaner security boundary
- clearer mental model
- better fit for future multi-agent and scheduler work

## ADR-004: Per-agent SQLite internal store

**Decision**: Internal state is stored in one SQLite database per agent:

- `~/.openhermit/{agent-id}/state.sqlite`

**Rationale**:

- avoids reintroducing file-based internal state
- keeps agent data isolated
- simplifies per-agent migration
- leaves room for future gateway-level aggregation without forcing a single global DB today

## ADR-005: Runtime discovery uses runtime.json

**Decision**: Agent-local discovery metadata is stored in:

- `~/.openhermit/{agent-id}/runtime.json`

Current contents include:

- HTTP API port
- bearer token
- update timestamp

**Rationale**:

- one extensible file is cleaner than multiple small runtime files
- easier to grow discovery metadata later
- keeps runtime discovery out of the workspace

## ADR-006: Sessions are durable threads

**Decision**: Sessions are durable threads identified by `sessionId`. They do not have a permanent `closed` state.

**Rationale**:

- old threads may be resumed later
- adapters should switch bindings, not close threads
- summarization should not depend on irreversible session closure

## ADR-007: Adapter binding is not agent-core state

**Decision**: The agent core only knows `sessionId`. Adapter binding decides which session a user/channel is currently using.

**Rationale**:

- keeps the runtime simple
- supports CLI, web, and IM channels uniformly
- keeps `/new` and resume semantics at the adapter level

## ADR-008: Episodic memory is checkpoint-based

**Decision**: Episodic memory stores checkpoint summaries, not a raw mirror of session events.

Current storage:

- `episodic_checkpoints` in `state.sqlite`

**Rationale**:

- avoids duplicating full session history
- keeps episodic memory retrieval-oriented
- provides a clean bridge from transcript to higher-level memory

## ADR-009: Program drives memory lifecycle

**Decision**: Memory lifecycle is program-driven, while summary content is agent-generated.

Program responsibilities:

- when to checkpoint
- what transcript range to summarize
- when to refresh working memory
- where to store results

Agent responsibilities:

- generate checkpoint summaries
- rewrite working memory
- generate promoted long-term memory content

Operational model:

- checkpoint triggers are program-driven, but checkpoint content is produced by the agent itself
- `memory.checkpoint_turn_interval` remains the trigger configuration for periodic checkpoint turns
- long-term consolidation runs separately during idle / low-activity periods

## ADR-010: Checkpointing and compaction are separate mechanisms

**Decision**: Checkpointing and compaction must remain separate.

**Checkpointing exists to update memory**:

- episodic checkpoints
- session-local working memory
- `now`

**Compaction exists to keep long-running sessions within model context limits**:

- compress older session context
- preserve recent continuity
- support retry after near-overflow or overflow

**Rationale**:

- memory generation and context-window hygiene are related but not the same job
- separating them keeps runtime behavior easier to reason about
- compaction should not silently become the only memory mechanism
- explicit user instructions such as "remember ..." may directly update long-term memory

**Rationale**:

- predictable lifecycle
- auditable behavior
- high-quality summarization without giving orchestration control to the model

## ADR-010: Container runtime state is internal, mounted data is external

**Decision**:

- container runtime inventory belongs to internal state
- mounted container data belongs to external state

**Rationale**:

- runtime lifecycle is orchestration data
- mounted files are task data the agent works on directly

## ADR-011: Scheduler is program-level orchestration

**Decision**: Scheduling should be a general program-level subsystem, not heartbeat-specific logic inside the agent runtime.

**Rationale**:

- heartbeat is only one kind of scheduled task
- scheduling should support cron, interval, one-shot, event, and dependency triggers
- the agent should execute runs, not own the scheduling model

## ADR-012: Agent-local API remains the execution contract

**Decision**: The per-agent runtime exposes an agent-local HTTP + SSE API:

- `POST /sessions`
- `GET /sessions`
- `GET /sessions/{sessionId}/messages`
- `POST /sessions/{sessionId}/messages`
- `POST /sessions/{sessionId}/approve`
- `POST /sessions/{sessionId}/checkpoint`
- `GET /sessions/{sessionId}/events`

**Rationale**:

- CLI, web, and future channels all reuse the same execution contract
- a future gateway can proxy this later without changing the per-agent runtime boundary
