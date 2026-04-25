# Architecture Decisions

This file records decisions that are still relevant to the current implementation.

## ADR-000: Platform-First Runtime

OpenHermit optimizes for hosted multi-agent operation instead of a single local assistant process. The gateway is the control plane, and agents are registered resources with durable state and lifecycle management.

## ADR-001: Internal State Is Outside The Workspace

Conversation history, memories, instructions, users, schedules, skills, MCP assignments, and container inventory are internal state. They live in PostgreSQL, scoped by `agent_id` where applicable.

The workspace is external task state: user files, generated artifacts, repositories, and mounted data.

## ADR-002: PostgreSQL With Drizzle Stores

`packages/store` uses Drizzle and PostgreSQL. SQL migrations live in `packages/store/drizzle/`; schema definitions live in `packages/store/src/schema.ts`.

PostgreSQL gives shared durable state for many agents, indexed event/session queries, and full-text memory search. Drizzle keeps query code close to TypeScript types without introducing a generated ORM client.

## ADR-003: Gateway-Managed In-Process Agents

The current gateway starts `AgentRunner` instances in-process through `AgentInstanceManager`. This is simpler than a reverse proxy over per-agent processes while preserving explicit `/agents/{agentId}/...` routing and per-agent lifecycle.

The `AgentInfo.port` field remains protocol-compatible metadata, but current managed agents do not require per-agent ports.

## ADR-004: Durable Sessions Do Not Close Permanently

Sessions are durable threads. They can be idle, running, awaiting approval, or inactive. `/new` and channel session switching mark old sessions inactive rather than destroying history.

## ADR-005: User Identity Is Channel-Based And Role-Gated

Users are resolved from `(channel, channelUserId)` identities. Roles are per-agent: `owner`, `user`, or `guest`.

Owners get full management tools. Users get standard memory/web/session access. Guests are intentionally restricted. Channel adapters can auto-create unknown identities as guests.

## ADR-006: Introspection And Compaction Are Separate

Compaction keeps model context within limits. Introspection maintains long-term memory, working memory, and session descriptions. They run on different triggers and use different tool surfaces.

## ADR-007: Program-Driven Scheduler

Scheduling is a first-class subsystem with cron and one-shot schedules. Schedules are stored in PostgreSQL, run through `Scheduler`, and post prompts back into agent sessions through `AgentRunner` host callbacks.

## ADR-008: Skills Are Prompt Assets, MCP Servers Are Tool Providers

Skills are directories containing `SKILL.md` and optional supporting files. They are indexed in the prompt and mounted into exec backends.

MCP servers are executable external tool providers. Their tools are discovered at runtime and exposed as namespaced `mcp__{serverId}__{toolName}` tools.

## ADR-009: Built-In Channels Run Beside Agents

Telegram, Discord, and Slack adapters are built-in channel packages. The gateway starts them when the agent config enables them, registers per-channel bearer tokens, and records status for the UI/API.

Adapters use the OpenHermit SDK over gateway agent routes instead of reaching into runner internals.

## ADR-010: Execution Backends Are Pluggable

The `exec` tool runs through an `ExecBackendManager`. Docker and local shell backends are currently implemented. Gateway-created agents default to Docker; missing config falls back to local shell for development and tests.
