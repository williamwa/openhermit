# MCP Servers

MCP (Model Context Protocol) servers extend an agent's tool capabilities by connecting to external HTTP-based tool providers at runtime. Unlike skills (which are prompt-based instructions), MCP servers expose **executable tools** discovered via the MCP protocol — the agent calls them like any built-in tool.

## Design Principles

- **HTTP only.** Only Streamable HTTP transport is supported. No stdio.
- **Persistent connections.** MCP connections are established once per agent runner and reused across turns. The initialization handshake (capability negotiation + tool discovery) is expensive, so connections persist until the agent shuts down.
- **Graceful degradation.** A failed MCP connection never blocks agent execution. The server is marked as `error`/`disconnected`, and the agent proceeds with its remaining tools.
- **Agent self-management.** The agent gets tools to inspect MCP status and (for owners) enable/disable servers at runtime.

## Database Schema

### `mcp_servers` Table

Stores all registered MCP server definitions.

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Server identifier |
| `name` | TEXT | Display name |
| `description` | TEXT | One-line summary |
| `url` | TEXT | HTTP endpoint URL |
| `headers_json` | TEXT | JSON object of auth/custom headers (default `{}`) |
| `metadata_json` | TEXT | JSON blob for tags, notes, etc. (default `{}`) |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

### `agent_mcp_servers` Table

Tracks which MCP servers are enabled for which agents.

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT | Agent ID, or `*` for all agents |
| `mcp_server_id` | TEXT | MCP server reference |
| `enabled` | BOOLEAN | Whether the assignment is active |
| `created_at` | TEXT | ISO 8601 timestamp |
| **PK** | | `(agent_id, mcp_server_id)` |

## Connection Lifecycle

1. **Agent startup**: The runner queries enabled MCP servers for the agent (including `agent_id = '*'` global assignments).
2. **First session**: `McpClientManager` connects to all enabled servers via `StreamableHTTPClientTransport`, negotiates capabilities, and discovers tools via `listTools()`.
3. **Across turns**: Connections and discovered tools are reused. Each `createConfiguredAgent()` call picks up the current tool state from the live `McpClientManager`.
4. **Mid-session failure**: If a tool call fails due to connection loss, the error is returned as a tool result (not thrown). The server is marked as `error`. The agent can check status via `mcp_status`.
5. **Shutdown**: `McpClientManager.disconnectAll()` closes all connections cleanly.

## Tool Naming

MCP tools are namespaced to avoid collisions:

```
mcp__<serverId>__<toolName>
```

For example, a tool `search` from server `github-tools` becomes `mcp__github-tools__search`.

Each tool's label shows the human-readable form: `[GitHub Tools] search`.

## Agent Tools

### `mcp_status` (all roles)

Returns JSON listing all MCP server connection states:

- Server ID and name
- Connection status (`connected` / `disconnected` / `error`)
- Tool count
- Last error message (if any)
- Connected since timestamp

### `mcp_enable` (owner only)

Enables an MCP server for the current agent. Persists the assignment to the database and immediately connects.

Parameters: `{ serverId: string }`

### `mcp_disable` (owner only)

Disables an MCP server for the current agent. Disconnects immediately and persists the change.

Parameters: `{ serverId: string }`

## Admin API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/mcp-servers` | List all MCP servers |
| POST | `/api/admin/mcp-servers` | Create/upsert a server |
| GET | `/api/admin/mcp-servers/assignments` | List all agent assignments |
| GET | `/api/admin/mcp-servers/:id` | Get one server |
| DELETE | `/api/admin/mcp-servers/:id` | Delete a server |
| POST | `/api/admin/mcp-servers/:id/enable` | Enable for agent (body: `{agentId?}`, default `*`) |
| POST | `/api/admin/mcp-servers/:id/disable` | Disable for agent |

### Per-Agent Endpoint

```
GET /api/agents/:agentId/mcp-servers
```

Returns the list of MCP servers enabled for a specific agent (including global `*` assignments).

## Admin UI

The gateway admin UI includes an **MCP** tab for managing servers:

- **Server list**: Cards showing name, description, URL, and assignment count
- **Create/edit dialog**: Fields for ID, name, description, URL, and headers (JSON)
- **Assignments dialog**: Manage per-agent or global (`*`) enable/disable

Each agent card in the Agents panel also has an **MCP** button that shows the MCP servers enabled for that agent.

## Implementation Files

| File | Description |
|------|-------------|
| `packages/store/src/schema.ts` | Drizzle schema for `mcp_servers` and `agent_mcp_servers` tables |
| `packages/store/src/impl/mcp-server-store.ts` | `DbMcpServerStore` implementation |
| `apps/agent/src/mcp-client.ts` | `McpClientManager` — connection lifecycle, tool adaptation |
| `apps/agent/src/tools/mcp.ts` | `mcp_status`, `mcp_enable`, `mcp_disable` tool definitions |
| `apps/agent/src/agent-runner.ts` | Integration point — connects on first session, wires tools |
| `apps/gateway/src/app.ts` | Admin API endpoints |
| `apps/gateway/ui/src/components/McpServersPanel.tsx` | Admin UI panel |
