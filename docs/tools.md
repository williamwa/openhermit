# Built-in Tools

All tools are conditionally registered based on available context providers. Tools marked with approval icon (🔐) require user approval when not in full-autonomy mode. Tools marked with write icon (✏️) are blocked in readonly mode.

## Memory

Requires: `memoryProvider`

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `memory_get` | Read one memory entry by exact ID | `id` (string, required) | | |
| `memory_recall` | Search memory entries by keyword/phrase (stemming, token-level match) | `query` (string, required), `limit` (number, optional, default 5, max 10) | | |
| `memory_add` | Create or upsert a memory entry. Prefer semantic IDs like `project/plan` or `user/{userId}/preferences` | `id` (string, optional), `content` (string, required), `metadata` (object, optional) | ✓ | ✓ |
| `memory_update` | Update an existing memory entry by ID | `id` (string, required), `content` (string, optional), `metadata` (object, optional) | ✓ | ✓ |
| `memory_delete` | Delete a memory entry by ID | `id` (string, required) | ✓ | ✓ |

## Instructions

Requires: `instructionStore`

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `instruction_update` | Update an instruction entry (identity, soul, agents, etc.) | `key` (string, required), `content` (string, required) | ✓ | ✓ |

## Web

Requires: `webProvider`

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `web_search` | Search the web. Returns titles, URLs, snippets. Use `content_mode: "full"` for page content | `query` (string, required), `limit` (number, optional, default 5, max 10), `content_mode` (enum: `snippet` \| `full`, optional, default `snippet`) | | |
| `web_fetch` | Fetch a web page. `markdown` mode extracts main content, `raw` returns HTTP body | `url` (string, required), `max_bytes` (number, optional, default 200000), `output` (enum: `raw` \| `markdown`, optional, default `markdown`) | | |

## Workspace Execution

Requires: `agentId` + workspace container config

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `exec` | Execute a shell command in the workspace container (`/workspace`). Approval is cached per unique command string | `command` (string, required) | ✓ | ✓ |

## User Management

Requires: `userStore`

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `user_list` | List all users with identities and roles | _(none)_ | | |
| `user_identity_link` | Link a channel identity to a user. Re-links if already assigned elsewhere | `user_id` (string, required), `channel` (string, required), `channel_user_id` (string, required) | ✓ | ✓ |
| `user_identity_unlink` | Remove a channel identity link | `channel` (string, required), `channel_user_id` (string, required) | ✓ | ✓ |
| `user_role_set` | Change a user's role | `user_id` (string, required), `role` (enum: `owner` \| `user` \| `guest`, required) | ✓ | ✓ |
| `user_merge` | Merge one user into another. Moves all identities; source marked as merged | `from_user_id` (string, required), `into_user_id` (string, required) | ✓ | ✓ |

## Session Management

Requires: `sessionStore`

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `session_list` | List sessions with descriptions, last activity, message counts, source | `channel` (string, optional), `limit` (number, optional, default 20) | | |
| `session_read` | Read message history from a session. Use `offset` to page backwards | `session_id` (string, required), `limit` (number, optional, default 50), `offset` (number, optional, default 0) | | |
| `session_summary` | Get session summary: description, working memory, message count, recent activity | `session_id` (string, required) | | |
| `session_send` | Send a message to another session via its connected channel (e.g. Telegram) | `session_id` (string, required), `text` (string, required) | ✓ | ✓ |

## Schedules

Requires: `scheduleStore`

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `schedule_list` | List all scheduled jobs with status, next run time, run count | `status` (string, optional) | | |
| `schedule_create` | Create a cron or one-time scheduled job | `type` (enum: `cron` \| `once`, required), `prompt` (string, required), `cron_expression` (string, optional), `run_at` (string, optional), `id` (string, optional), `delivery` (`"silent"` or `{session: id}`, optional), `timeout_seconds` (number, optional) | ✓ | ✓ |
| `schedule_update` | Update a schedule's status, prompt, or cron expression | `id` (string, required), `status` (enum: `active` \| `paused`, optional), `prompt` (string, optional), `cron_expression` (string, optional), `run_at` (string, optional) | ✓ | ✓ |
| `schedule_delete` | Delete a scheduled job permanently | `id` (string, required) | ✓ | ✓ |
| `schedule_trigger` | Trigger a scheduled job immediately | `id` (string, required) | ✓ | ✓ |
| `schedule_runs` | View execution history for a schedule | `id` (string, required), `limit` (number, optional, default 10) | | |

## MCP Server Management

Requires: `mcpClientManager` (automatically available when MCP servers are configured)

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `mcp_status` | List all MCP server connection states (id, name, status, tool count, last error) | _(none)_ | | |
| `mcp_enable` | Enable an MCP server for this agent. Connects immediately | `serverId` (string, required) | ✓ | ✓ |
| `mcp_disable` | Disable an MCP server for this agent. Disconnects immediately | `serverId` (string, required) | ✓ | ✓ |

In addition to management tools, each connected MCP server's tools are exposed as `mcp__<serverId>__<toolName>` and behave like any other agent tool (subject to approval gating).

## Introspection-only Tools

These tools are **not** available to the main agent. They are registered exclusively for the introspection agent during background session checkpoints.

| Tool | Description | Parameters |
|------|-------------|------------|
| `working_memory_update` | Replace session-local working memory (scratchpad). Injected into context every turn | `content` (string, required) |
| `session_description_update` | Update the session title shown in listings. Under 10 words, plain text | `description` (string, required) |

The introspection agent also has access to all memory tools (`memory_get`, `memory_recall`, `memory_add`, `memory_update`, `memory_delete`).

---

## Autonomy & Approval

- **Readonly mode**: All write/mutating tools (✏️) are blocked entirely via `ensureAutonomyAllows()`.
- **Approval gating** (🔐): When autonomy is not `full`, the agent asks the user for confirmation before executing. The approval callback is provided by the channel adapter.
- **Approval caching**: `exec` caches approval per command string. Same command in a session won't prompt twice.

## Role-based Access

Tool availability is filtered by user role in `createBuiltInToolsets()`:

| Role | Available Tools |
|------|----------------|
| **owner** | All tools (memory, instruction, web, exec, user, session, session_send, schedule, mcp_status/enable/disable) |
| **user** | memory, web, exec, session, session_send, mcp_status |
| **guest** | web, session (read-only: list/read/summary), schedule_list, schedule_runs |

Owner-only stores (`instructionStore`, `userStore`, `scheduleStore`) are only injected for the owner role. Guest-blocked tools (`exec`, `schedule_create/update/delete/trigger`) are filtered at the runner level. `session_send` requires `channelOutbound` adapters to be available.
