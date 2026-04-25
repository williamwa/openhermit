# Tools

OpenHermit builds toolsets per turn from available runtime capabilities and the resolved user role. Tools are wrapped by the approval gate according to `security.json`.

## Built-In Tools

| Tool | Purpose |
|------|---------|
| `exec` | Run a shell command through the configured exec backend |
| `web_search` | Search the web through the configured web provider |
| `web_fetch` | Fetch and extract web page content |
| `memory_get` | Read one memory by ID |
| `memory_list` | List memories by prefix |
| `memory_recall` | Search memories |
| `memory_add` | Create or replace a memory |
| `memory_update` | Update memory content/metadata |
| `memory_delete` | Delete a memory |
| `instruction_update` | Update an instruction key |
| `user_list` | List users, roles, and identities |
| `user_identity_link` | Link an identity to a user |
| `user_identity_unlink` | Remove an identity link |
| `user_role_set` | Set a user's role for the agent |
| `user_merge` | Merge one user into another |
| `session_list` | List sessions |
| `session_read` | Read session history |
| `session_summary` | Read description, working memory, and recent activity |
| `session_send` | Send a proactive message through a connected channel |
| `schedule_list` | List schedules |
| `schedule_create` | Create cron or once schedules |
| `schedule_update` | Update schedule status/prompt/timing |
| `schedule_delete` | Delete a schedule |
| `schedule_trigger` | Run a schedule immediately |
| `schedule_runs` | List schedule run history |
| `mcp_status` | Show MCP connection/tool status |
| `mcp_enable` | Enable/connect an MCP server for this agent |
| `mcp_disable` | Disable/disconnect an MCP server for this agent |

Introspection-only tools:

- `working_memory_update`
- `session_description_update`

Connected MCP server tools are exposed as:

```text
mcp__{serverId}__{toolName}
```

## Runtime Requirements

| Tool area | Required capability |
|-----------|---------------------|
| exec | `agentId`, workspace, `ExecBackendManager` |
| web | configured web provider |
| memory | `memoryProvider` |
| instruction | `instructionStore` |
| users | `userStore` |
| sessions | `sessionStore` |
| schedules | `scheduleStore` |
| session_send | matching channel outbound adapter |
| MCP management | `McpClientManager` and MCP store |

## Role Filtering

| Role | Tool access |
|------|-------------|
| `owner` | all available built-ins and MCP management |
| `user` | normal interaction tools, memory, web, and read-oriented session access |
| `guest` | restricted read/web access; no exec or mutating management tools |

The exact set is assembled in `AgentRunner.createAgent()` from the resolved role and available stores.

## Approval

`security.json` controls approval behavior:

```json
{
  "autonomy_level": "supervised",
  "require_approval_for": ["exec"]
}
```

Autonomy levels:

- `readonly`
- `supervised`
- `full`

When approval is required, the runtime emits `tool_approval_required` and pauses until `/approve` or WebSocket `session.approve` resolves the tool call. Interactive sessions provide an approval callback; channel adapters currently auto-approve channel approvals.
