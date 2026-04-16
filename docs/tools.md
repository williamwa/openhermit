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

## Containers (disabled)

Currently disabled in `tools.ts`. Defined but not registered.

| Tool | Description | Parameters | 🔐 | ✏️ |
|------|-------------|------------|:--:|:--:|
| `container_run` | Run a one-off command in an ephemeral Docker container | `image`, `command`, `description`?, `mount`?, `mount_target`?, `env_secrets`?, `workdir`? | ✓ | ✓ |
| `container_status` | List known containers and their current status | _(none)_ | | |
| `container_start` | Start a long-running service container. Approval cached by container name | `name`, `image`, `description`?, `mount`?, `mount_target`?, `ports`?, `env`?, `env_secrets`?, `network`? | ✓ | ✓ |
| `container_stop` | Stop a running service container | `name` | ✓ | ✓ |
| `container_exec` | Execute a shell command inside a running container | `name`, `command` | ✓ | ✓ |

---

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
- **Approval caching**: `exec` caches approval per command string; `container_start` caches per container name. Same command in a session won't prompt twice.

## Role-based Access

Tool availability is filtered by user role in `createBuiltInToolsets()`:

| Role | Available Tools |
|------|----------------|
| **owner** | All tools |
| **user** | memory, instruction, web, exec, user (read-only subset) |
| **guest** | web, session (read-only), memory_get, memory_recall |

The exact gating is implemented per-tool via the `context.userRole` check at registration time.
