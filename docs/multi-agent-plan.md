# OpenHermit: Multi-Agent + Store Abstraction + Plugin Architecture

Status: draft plan, under discussion.

## Context

OpenHermit is a single-agent-per-process runtime today. The goal is to evolve it to support:
1. **Multi-agent with shared database** — all tables scoped by `agent_id`
2. **Workspace container** — each agent gets a persistent Docker container with the workspace mounted in
3. **Plugin architecture** — tools, channels, webhooks, skills, hooks are per-agent configurable

The three confirmed design constraints:
- Gateway and Agent stay **separate processes** — agent can run standalone, gateway manages multiple agents
- Workspace files are **mounted into** the workspace container from the storage volume
- Plugin mechanism covers **more than tools** — webhooks, channels, skills, hooks — and each agent may have different plugins

---

## Phase 1: Store Abstraction ✅ Completed

**Goal**: Extract store interfaces from the current god objects. No behavior change.

> **Status**: Implemented in `packages/store/`. Schema is now at v8.

### 1.1 Create `packages/store`

New package with store interfaces and SQLite adapters.

```
packages/store/
  src/
    index.ts                    — re-exports
    types.ts                    — StoreScope, MemoryEntry, MemoryAddInput, etc.
    interfaces.ts               — SessionStore, MessageStore, MemoryProvider, ContainerStore, InstructionStore, InternalStateStore
    sqlite/
      index.ts                  — SqliteInternalStateStore
      session-store.ts          — extracted from SessionIndexStore
      message-store.ts          — extracted from SessionLogWriter (log/checkpoint/history methods)
      memory-provider.ts        — SqliteMemoryProvider (implements MemoryProvider)
      container-store.ts        — extracted from ContainerRegistryStore
      instruction-store.ts      — SqliteInstructionStore
      migrations.ts             — schema init + migrations (v8)
```

### 1.2 Interface Design

```ts
interface StoreScope {
  agentId: string;
}

interface SessionStore {
  upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void>;
  get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined>;
  list(scope: StoreScope): Promise<PersistedSessionIndexEntry[]>;
}

interface MessageStore {
  appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<void>;
  appendEpisodicEntry(scope: StoreScope, sessionId: string, entry: EpisodicLogEntry): Promise<void>;
  listHistoryMessages(scope: StoreScope, sessionId: string): Promise<SessionHistoryMessage[]>;
  listCheckpointHistory(scope: StoreScope, sessionId: string): Promise<...>;
  listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]>;
  listEpisodicEntries(scope: StoreScope, sessionId: string): Promise<EpisodicLogEntry[]>;
  getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined>;
  setSessionWorkingMemory(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void>;
  writeSessionStarted(scope: StoreScope, spec: SessionSpec, model: {...}): Promise<void>;
}

interface MemoryProvider {
  readonly name: string;
  initialize(scope: StoreScope): Promise<void>;
  shutdown(): Promise<void>;
  add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry>;
  search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined>;
  update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry>;
  delete(scope: StoreScope, id: string): Promise<void>;
  getContextBlock(scope: StoreScope): Promise<string | undefined>;
}

interface InstructionStore {
  get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined>;
  getAll(scope: StoreScope): Promise<InstructionEntry[]>;
  set(scope: StoreScope, key: string, content: string, updatedAt: string): Promise<void>;
}

interface ContainerStore {
  readAll(scope: StoreScope): Promise<ContainerRegistryEntry[]>;
  findByName(scope: StoreScope, name: string): Promise<ContainerRegistryEntry | undefined>;
  upsert(scope: StoreScope, entry: ContainerRegistryEntry): Promise<void>;
  updateByName(scope: StoreScope, name: string, updater: (e: ContainerRegistryEntry) => ContainerRegistryEntry): Promise<ContainerRegistryEntry>;
}

interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryProvider;
  containers: ContainerStore;
  instructions: InstructionStore;
  close(): void;
}
```

### 1.3 Schema Migration (v5)

Add `agent_id TEXT NOT NULL DEFAULT '__standalone__'` to:
- `sessions`
- `session_messages`
- `session_events`
- `episodic_checkpoints`
- `memories`
- `container_runtime_entries`

Add composite indexes: `(agent_id, session_id)`, `(agent_id, memory_key)`, etc.

Existing per-agent DBs get the default `'__standalone__'` — zero data migration needed.

### 1.4 Wire into AgentRunner

- `AgentRunnerOptions` gains `store?: InternalStateStore`
- If `store` provided: use it. If not: create `SqliteInternalStateStore` from `security.stateFilePath` (preserving standalone behavior).
- `ToolContext.memoryProvider` changes type from `SessionLogWriter` to `MemoryProvider`
- `DockerContainerManager` accepts optional `ContainerStore` instead of opening its own DB

### Key files to modify:
- `apps/agent/src/agent-runner.ts:213-224` — constructor, replace direct DB usage
- `apps/agent/src/agent-runner/types.ts` — add `store` to `AgentRunnerOptions`
- `apps/agent/src/tools/shared.ts:36-44` — `ToolContext.memoryStore` type change
- `apps/agent/src/tools/memory.ts` — use `MemoryProvider` interface methods
- `apps/agent/src/core/container-manager.ts:319-335` — accept `ContainerStore`
- `apps/agent/src/internal-state/sqlite.ts` — migrations move to `packages/store/src/sqlite/migrations.ts`

### Key files to extract from:
- `apps/agent/src/session-logs/writer.ts` → `SqliteMessageStore` + `SqliteMemoryProvider`
- `apps/agent/src/session-logs/index-store.ts` → `SqliteSessionStore`
- `apps/agent/src/core/container-manager.ts` (ContainerRegistryStore) → `SqliteContainerStore`

---

## Phase 2: Multi-Agent Gateway

**Goal**: Gateway manages multiple agent processes and provides a unified API.

**Key decision**: Each agent is its own independent process. Gateway is a reverse proxy + process manager, not an in-process host for AgentRunner instances.

### 2.1 Architecture

```
Gateway process (Hono)
  ├─ /agents                         — list registered agents
  ├─ /agents/:agentId/health         — health check (proxied)
  ├─ /agents/:agentId/sessions/...   — proxied to agent process
  └─ /agents/:agentId/manage/...     — lifecycle: start, stop, restart
        │
        ├─ Agent process A (port 3001)  ← standalone apps/agent
        ├─ Agent process B (port 3002)  ← standalone apps/agent
        └─ Agent process C (port 3003)  ← standalone apps/agent
```

Gateway does NOT import AgentRunner. It:
- Manages agent process lifecycle (spawn, stop, health check, restart)
- Maintains an agent registry (config + runtime state)
- Proxies `/agents/:agentId/...` requests to the correct agent's `localhost:{port}/...`
- Discovers agent ports via `runtime.json` or internal registry

Each agent process is exactly the current `apps/agent` — no changes needed to agent code for gateway support.

### 2.2 Protocol Changes

Add to `packages/protocol/src/index.ts`:

```ts
export const gatewayRoutes = {
  agents: '/agents',
  agentHealthPattern: '/agents/:agentId/health',
  agentSessionsPattern: '/agents/:agentId/sessions',
  agentSessionMessagesPattern: '/agents/:agentId/sessions/:sessionId/messages',
  agentSessionEventsPattern: '/agents/:agentId/sessions/:sessionId/events',
  agentSessionApprovePattern: '/agents/:agentId/sessions/:sessionId/approve',
  agentSessionCheckpointPattern: '/agents/:agentId/sessions/:sessionId/checkpoint',
  agentManagePattern: '/agents/:agentId/manage/:action',
};
```

Agent-local routes (`/sessions/...`) remain unchanged — gateway strips the `/agents/:agentId` prefix before proxying.

### 2.3 SDK Changes

Add `GatewayClient` to `packages/sdk`:
- Constructor: `{ baseUrl, token }`
- `listAgents()` — returns registered agents and their status
- `agent(agentId)` — returns an `AgentLocalClient` scoped to that agent via gateway URL
- Internally prefixes all requests with `/agents/{agentId}`

### 2.4 Gateway Implementation (`apps/gateway`)

```
apps/gateway/src/
  index.ts              — main entry, boot Hono server
  app.ts                — Hono app with proxy routes
  agent-registry.ts     — agent config registry (from config file or DB)
  agent-lifecycle.ts    — spawn/stop/health-check agent processes
  proxy.ts              — HTTP + SSE proxy to agent processes
```

Agent registry stores per-agent config:
```ts
interface AgentRegistryEntry {
  agentId: string;
  workspaceRoot: string;
  status: 'registered' | 'starting' | 'running' | 'stopped' | 'error';
  port?: number;         // discovered from runtime.json or assigned
  config?: Record<string, unknown>;  // agent-specific overrides
}
```

### 2.5 Standalone vs Managed

| | Standalone | Managed (via Gateway) |
|---|---|---|
| Process | One per agent | One per agent + gateway process |
| Database | Per-agent SQLite | Per-agent SQLite (or shared Postgres) |
| Agent routes | `/sessions/...` | `/sessions/...` (unchanged) |
| Client connects to | Agent directly | Gateway at `/agents/:agentId/...` |
| Discovery | `runtime.json` | Gateway API |
| Agent code changes | None | None |

The agent process is identical in both modes. Gateway is purely additive — it proxies and manages, but never modifies agent behavior.

---

## Phase 3: Workspace Container ✅ Completed

**Goal**: Each agent gets a persistent container with workspace mounted.

> **Status**: Implemented. `workspace_exec` tool exists, workspace container type exists in `ContainerType`.

### 3.1 Container Type Extension

`core/types.ts`: add `'workspace'` to `ContainerType`.

Add to `AgentRuntimeConfig`:
```ts
workspace_container?: {
  image: string;           // e.g. "ubuntu:22.04"
  memory_limit?: string;
  cpu_shares?: number;
}
```

### 3.2 DockerContainerManager Changes

Add methods:
```ts
async ensureWorkspaceContainer(agentId: string, config: WorkspaceContainerConfig): Promise<ContainerRegistryEntry>
async getWorkspaceContainer(agentId: string): Promise<ContainerRegistryEntry | undefined>
```

Container name: `{agentId}-workspace`. Mounts workspace root at `/workspace`. Idempotent — creates if missing, starts if stopped, returns if running.

### 3.3 New Tool: `workspace_exec`

```ts
createWorkspaceExecTool(context): AgentTool
// Runs a command inside the workspace container
// Ensures container exists before execution
// Uses DockerContainerManager.execInService() internally
```

### 3.4 File Access

File tools have been removed. All file operations are performed via `workspace_exec` inside the workspace container, which has the workspace mounted at `/workspace`.

### Key files:
- Modify: `apps/agent/src/core/types.ts`, `apps/agent/src/core/container-manager.ts`
- New: `apps/agent/src/tools/workspace-exec.ts`
- Modify: `apps/agent/src/tools.ts` (add workspace_exec to built-in tools)
- Modify: `apps/agent/src/agent-runner.ts` (call ensureWorkspaceContainer on session open)

---

## Phase 4: Plugin Architecture

**Goal**: Per-agent configurable extensions covering tools, channels, webhooks, hooks, API routes.

### 4.1 Extension Points

| Extension Point | What it provides | When it's called |
|---|---|---|
| **tools** | `AgentTool[]` — additional tools for the LLM | During agent creation |
| **hooks** | Callbacks at lifecycle points | onSessionStart, beforeToolCall, afterToolCall, etc. |
| **routes** | Hono route handlers | Mounted on agent's HTTP server |
| **webhooks** | Inbound HTTP → agent message | Mounted as routes, convert external events to messages |
| **channels** | Bidirectional messaging bridge | Runs alongside agent, maps external platform ↔ sessions |
| **skills** | Composed tool+prompt recipes | Registered as tools with richer semantics |

### 4.2 Plugin Manifest

```ts
// packages/plugin/src/types.ts

interface PluginManifest {
  id: string;                                    // "openhermit-plugin-github"
  name: string;                                  // "GitHub Integration"
  version: string;

  tools?: (ctx: PluginContext) => AgentTool[];
  hooks?: Partial<Record<HookPoint, HookHandler>>;
  routes?: (ctx: PluginContext) => Hono;          // sub-app, mounted under /plugins/{pluginId}/
  webhooks?: (ctx: PluginContext) => WebhookHandler[];
  channels?: (ctx: PluginContext) => ChannelAdapter[];

  activate?: (ctx: PluginContext) => Promise<void>;
  deactivate?: (ctx: PluginContext) => Promise<void>;
}
```

### 4.3 Plugin Context

```ts
interface PluginContext {
  agentId: string;
  workspace: AgentWorkspace;
  security: AgentSecurity;
  containerManager: DockerContainerManager;
  store: InternalStateStore;
  events: SessionEventBroker;
  logger: (message: string) => void;
  settings: Record<string, unknown>;   // per-plugin config from agent config
}
```

### 4.4 Per-Agent Configuration

In `AgentRuntimeConfig`:
```ts
plugins?: Array<{
  id: string;
  enabled: boolean;
  settings?: Record<string, unknown>;
}>;
```

### 4.5 Plugin Manager

```ts
// packages/plugin/src/manager.ts

class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();

  async load(manifest: PluginManifest, context: PluginContext): Promise<void>;
  async unload(pluginId: string): Promise<void>;

  getAllTools(): AgentTool[];
  getRoutes(): Array<{ pluginId: string; app: Hono }>;
  getHooks(point: HookPoint): HookHandler[];
  getChannels(): ChannelAdapter[];
}
```

### 4.6 Integration into AgentRunner

During agent initialization:
1. Read agent's plugin config
2. Import each plugin module
3. Call `pluginManager.load(manifest, context)` for each
4. Merge `pluginManager.getAllTools()` with built-in tools
5. Mount `pluginManager.getRoutes()` on the HTTP app
6. Start `pluginManager.getChannels()`

Plugin tools go through the **same `withApproval` wrapper** — the existing approval system works with any tool name string.

### 4.7 New Package Structure

```
packages/plugin/
  src/
    index.ts        — re-exports
    types.ts        — PluginManifest, PluginContext, HookHandler, ChannelAdapter, WebhookHandler
    manager.ts      — PluginManager
```

### Key files:
- New: `packages/plugin/`
- Modify: `apps/agent/src/agent-runner.ts` (create PluginManager, merge tools)
- Modify: `apps/agent/src/app.ts` (mount plugin routes)
- Modify: `apps/agent/src/core/types.ts` (add plugins to AgentRuntimeConfig)
- Refactor: `apps/channels/telegram/` → first plugin example

---

## Implementation Order

```
Phase 1 (Store Abstraction)     ✅ Completed
  ↓
Phase 2 (Gateway) ←→ Phase 3 (Workspace Container)  ✅ Both completed
  ↓
Phase 4 (Plugin Architecture)   — next major work item
```

Phases 1, 2 (basic gateway), and 3 are complete. Phase 4 builds on all three — plugins access `InternalStateStore` and need to work in both standalone and managed mode.

---

## Verification

After Phase 1:
- Run existing tests — all should pass with no behavior change
- `npm run dev:agent` starts standalone agent exactly as before
- `npm run chat:agent` works as before

After Phase 2:
- `npm run dev:gateway` starts gateway with multiple agents
- Gateway API at `/agents/{agentId}/sessions/...` works
- Standalone mode still works independently

After Phase 3:
- Agent creates workspace container on startup
- `workspace_exec` tool works
- File operations work via `workspace_exec` inside the workspace container
- Files are visible inside workspace container

After Phase 4:
- Agent loads plugins from config
- Plugin tools appear in agent's tool list
- Plugin routes are accessible
- Different agents can have different plugin configurations
