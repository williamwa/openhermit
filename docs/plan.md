# Roadmap

This roadmap reflects the current implementation after the gateway, schedules, skills, MCP, and built-in channels landed.

## Implemented

- gateway-managed agents with PostgreSQL-backed agent records
- admin UI at `/admin/`
- CLI setup, gateway lifecycle, agent lifecycle, chat, config/secrets, logs/status, schedules
- Drizzle/PostgreSQL internal store
- durable sessions and session events
- user identities, roles, merges, and role-based tool filtering
- memory tools, working memory, introspection, and context compaction
- Docker, host, and E2B exec backends
- web search/fetch providers
- cron/once scheduler with run history
- Telegram, Discord, and Slack built-in adapters
- runtime channel enable/disable/config management
- skills registry, assignments, prompt index, and skill mounts
- MCP server registry, assignments, runtime status, and namespaced tools
- HTTP sync, inline SSE streaming, durable SSE, and WebSocket RPC/event subscriptions

## Active Gaps

- richer deployment story beyond local gateway process management
- centralized monitoring and metrics beyond logs/stats
- stronger production migration runner for installed packages
- finer-grained session capability policies beyond current role filtering
- broader end-to-end channel test coverage with real platform fixtures
- packaged docs for external channel adapter authors
- clearer secret handling for MCP headers and channel credentials in hosted deployments

## Near-Term Priorities

1. Harden gateway operations: migrations, logs, health, and restart behavior.
2. Expand tests around WebSocket, channel routing, schedules, and MCP failure modes.
3. Tighten role/capability documentation and enforcement for group sessions.
4. Improve admin UI coverage for skills, MCP, channels, schedules, users, and logs.
5. Document deployment patterns for a long-running gateway plus PostgreSQL.

## Non-Goals For Now

- preserving legacy single-agent process compatibility
- adding new database backends
- adding a plugin framework separate from current skills, MCP, and channel packages
- treating workspace files as durable internal state
