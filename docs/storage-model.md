# Storage Model

OpenHermit stores durable internal state in PostgreSQL through Drizzle. The schema lives in [../packages/store/src/schema.ts](../packages/store/src/schema.ts), and SQL migrations live in [../packages/store/drizzle/](../packages/store/drizzle/).

## Database Scope

Most tables include `agent_id` and are queried through a `StoreScope`. This gives every agent an isolated state view while sharing one PostgreSQL database.

Global tables:

- `meta`
- `users`
- `user_identities`
- `skills`
- `mcp_servers`

Agent-scoped tables:

- `agents`
- `sessions`
- `session_events`
- `memories`
- `containers`
- `instructions`
- `user_agents`
- `agent_skills`
- `agent_mcp_servers`
- `schedules`
- `schedule_runs`

## Tables

| Table | Purpose |
|-------|---------|
| `agents` | Registered agents — runtime config, security policy, config & workspace directories |
| `sessions` | Durable session index: source, metadata, status, participants, descriptions, working memory |
| `session_events` | Full persisted event log for messages, tool calls/results, errors, and introspection |
| `memories` | Long-term memories keyed by `memory_key` |
| `containers` | Workspace container runtime inventory |
| `instructions` | Prompt instructions by key |
| `users` | User records and merge links |
| `user_agents` | User role per agent |
| `user_identities` | Channel identity to user mapping |
| `skills` | Registered skill metadata and host paths |
| `agent_skills` | Global (`*`) and per-agent skill assignments |
| `mcp_servers` | Registered external MCP HTTP servers |
| `agent_mcp_servers` | Global (`*`) and per-agent MCP assignments |
| `schedules` | Cron and one-shot schedule definitions |
| `schedule_runs` | Schedule execution history |

## Wildcard assignments (`agent_id = '*'`)

Some assignment tables support a wildcard agent identifier `'*'` that means
"every agent." A wildcard assignment is a single row stored once; it is
matched at query time, not fanned out at write time:

```sql
WHERE agent_id IN ($agentId, '*')
```

This means:

- One write affects every agent, including agents created later.
- Removing the wildcard removes it for all agents in one operation.
- There are no per-agent rows to keep in sync.

| Table | Wildcard supported | Runtime sync on change |
|-------|--------------------|------------------------|
| `agent_skills` | ✅ | gateway calls `syncAffectedAgentSkillMounts` |
| `agent_mcp_servers` | ✅ | gateway calls `runner.reloadMcpServers()` |
| `schedules` | ❌ — each schedule is owned by exactly one agent | n/a |
| `agent_channels` | ❌ — adapters bind to a specific bot identity | n/a |

The admin UI, REST API, and CLI all accept `*` in the `agentId` field to
write or remove a wildcard assignment. Example:

```bash
hermit skills enable my-skill --agent '*'
hermit mcp enable my-mcp-server --agent '*'
```

When designing a new assignment table, prefer the wildcard pattern unless
the resource semantically requires per-agent identity (channels) or
per-agent ownership (schedules).

## Memory Search

`memories.content_tsv` is a generated PostgreSQL `tsvector` column created by migration SQL or lazily by `DbMemoryProvider.ensureFts()`. Search uses:

1. `plainto_tsquery('english', query)` ranked with `ts_rank`
2. per-word `ILIKE` fallback across memory keys and content for partial matches and non-English/CJK content

## Agent config & security policy

The canonical source for an agent's runtime config and security policy
is the `agents` table:

| Column | Replaces |
|--------|----------|
| `agents.config_json` | the legacy per-agent `config.json` file |
| `agents.security_json` | the legacy per-agent `security.json` file |

All reads and writes go through the `AgentConfigStore` interface
(`packages/store`), implemented by `DbAgentConfigStore`. The
gateway's `POST /agents` flow seeds these columns with the default
template; `PUT /api/agents/:id/config` and `PUT /api/agents/:id/secrets`
also write through the stores.

To import a freshly-checked-out repo whose agents predate this change,
run the one-shot CLI:

```bash
hermit migrate-agent-config       # imports config.json + security.json into the DB
hermit migrate-agent-config --force  # overwrite even if columns are populated
```

After migration the legacy files can be deleted.

## Per-Agent Files

Files under `~/.openhermit/agents/{agentId}/` are runtime/local state, not
configuration:

| File / Dir | Purpose |
|------------|---------|
| `runtime.json` | runtime port + token written by the running agent process |
| `secrets.json` | provider/channel/MCP secrets (still file-backed via `FileSecretStore`; future work may move this into the DB through the same `SecretStore` interface) |
| `skill-mounts/` | generated symlinks to enabled DB-managed skills |

Secrets are accessed exclusively through the `SecretStore` interface;
gateway endpoints, config interpolation (`${{SECRET_NAME}}`), and
admin/owner APIs never read `secrets.json` directly.

Workspace files under `~/.openhermit/workspaces/{agentId}/` are external
task state, unchanged.

## Migrations

`hermit setup` applies the consolidated Drizzle SQL migration when `DATABASE_URL` is configured and the repo migration directory is available. Development can inspect the database with:

```bash
npm run dev:studio
```

Tests use `DATABASE_URL_TEST` through the root `npm test` script.
