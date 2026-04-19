# User Model

This document defines how OpenHermit identifies, resolves, and manages users across channels.

It supersedes the earlier `participant-model.md` draft.

## Problem

OpenHermit currently has no concept of "user". Sessions are identified by `sessionId`, and channel adapters map platform conversations to sessions (e.g. `tg:{chatId}`). But there is no way to:

- know who is talking across different channels
- apply per-user permissions or tool restrictions
- store per-user preferences and profile information
- attribute actions to a specific person

## Design

### Core Tables

Two tables in PostgreSQL, scoped by `agentId` like all existing tables.

#### `users`

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT NOT NULL | Agent scope (part of primary key) |
| `user_id` | TEXT NOT NULL | Stable user identifier (e.g. `usr-{ulid}`) |
| `role` | TEXT NOT NULL | `owner`, `user`, or `guest` |
| `name` | TEXT | Display name |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |
| `updated_at` | TEXT NOT NULL | ISO 8601 timestamp |

Primary key: `(agent_id, user_id)`

#### `user_identities`

| Column | Type | Description |
|--------|------|-------------|
| `agent_id` | TEXT NOT NULL | Agent scope |
| `user_id` | TEXT NOT NULL | FK to `users` |
| `channel` | TEXT NOT NULL | Channel type: `cli`, `web`, `telegram`, `slack`, `api` |
| `channel_user_id` | TEXT NOT NULL | Platform-specific user ID (e.g. Telegram user ID, CLI username) |
| `created_at` | TEXT NOT NULL | ISO 8601 timestamp |

Primary key: `(agent_id, channel, channel_user_id)`

A single user may have multiple identities across channels. A channel identity maps to exactly one user.

### User Roles

| Role | Description |
|------|-------------|
| `owner` | Full control. Can manage instructions, configuration, other users. First user is always owner. |
| `user` | Standard access. Can use the agent, read/write memory, run tools within allowed set. |
| `guest` | Limited access. Can converse but cannot use execution tools, modify memory, or access configuration. |

### Role-to-Tool Mapping

Roles control which tool categories are available:

| Tool Category | owner | user | guest |
|---------------|-------|------|-------|
| User management (`user_*`) | yes | no | no |
| Session management (`session_*`) | yes | no | no |
| Instruction tools (`instruction_*`) | yes | no | no |
| Memory tools (`memory_*`) | yes | yes | no |
| Exec (`exec`) | yes | yes | no |
| Container tools (`container_*`) | yes | yes | no |
| Web tools (`web_*`) | yes | yes | yes |
| Conversation only | yes | yes | yes |

The runtime filters the tool set before creating the agent context for each turn, based on the resolved user's role.

### User Profile in Memory

Structured user data (role, identities) lives in the `users` and `user_identities` tables.

Unstructured user knowledge (preferences, communication style, domain expertise, personal context) lives in the memory system under the convention:

```
user/{userId}/profile
user/{userId}/preferences
user/{userId}/context/{topic}
```

This follows the existing memory ID convention (e.g. `project/plan`) and keeps user knowledge within the same MemoryProvider interface. The agent and introspection system can read, write, and recall user memories using the standard memory tools.

## Identity Resolution

### Flow

```
Inbound message
    │
    ├─ channel adapter extracts (channel, channel_user_id)
    │   e.g. Telegram adapter: channel="telegram", channel_user_id="12345678"
    │   e.g. CLI: channel="cli", channel_user_id=OS username or configured identity
    │   e.g. Web: channel="web", channel_user_id=from auth token
    │
    ├─ lookup user_identities WHERE (agent_id, channel, channel_user_id)
    │
    ├─ found → resolve user_id → load user record → attach to session context
    │
    └─ not found → apply unknown user policy (see below)
```

### Unknown User Policy

When a message arrives from an unrecognized identity:

1. **Auto-create as guest** (default for channel adapters) — create a new user with `role=guest`, link the identity, and proceed with restricted tool access.
2. **Reject** — refuse the message. Useful when the agent should only serve known users.
3. **Owner approval** — queue for owner to approve and assign a role.

The policy is configurable per agent in `config.json`:

```json
{
  "users": {
    "unknown_user_policy": "auto_guest"
  }
}
```

Values: `auto_guest` (default), `reject`, `require_approval`.

### First User Bootstrap

On first boot (or migration), if no users exist:

- The first CLI or web connection creates the `owner` user automatically.
- The owner's channel identity is linked.
- Subsequent users are created through identity resolution or owner invitation.

## Identity Linking and User Merge

### Motivation

Users interact with the agent across multiple channels. The agent must support linking identities discovered at different times — often through natural conversation rather than admin APIs.

Typical scenario:

```
1. Telegram user 12345 sends a message
     → resolve("telegram", "12345") → not found
     → auto_guest → create usr-abc (guest), link telegram:12345
     → agent responds with guest-level tools

2. Owner says on CLI: "the Telegram user just now is me"
     → agent identifies intent: identity linking
     → agent looks up recent Telegram users → finds usr-abc (telegram:12345)
     → agent calls user_identity_link: move telegram:12345 from usr-abc to usr-owner
     → usr-abc marked as merged_into: usr-owner

3. Next Telegram message from 12345
     → resolve("telegram", "12345") → usr-owner → owner permissions
```

### Identity Linking Rules

- Only `owner` can link/unlink identities and change roles.
- Linking an identity that belongs to another user automatically triggers a merge evaluation.
- The agent performs linking through conversation using user management tools — not through admin-only APIs.

### User Merge Semantics

When a user record becomes empty (no remaining identities) after an identity is moved away, it should be merged into the target user:

| Data | Merge behavior |
|------|----------------|
| **Identities** | Re-linked to target user (the triggering operation) |
| **Message attribution** | Updated — session messages referencing old userId point to new userId |
| **Memory entries** | Agent-driven merge — the agent reads `user/{oldId}/*` and decides what to incorporate into `user/{newId}/*`. Programmatic merge of free-text profiles would lose nuance. |
| **Sessions** | Session `userId` references updated to new userId |
| **Old user record** | Kept with `merged_into` field set, not physically deleted. Preserves audit trail. |

The `users` table gains an optional column:

| Column | Type | Description |
|--------|------|-------------|
| `merged_into` | TEXT | If set, this user was merged into the specified userId |

Queries that resolve a userId should follow the `merged_into` chain (at most one hop in practice).

### Resolution Timing

Identity resolution happens **per-session** in the initial implementation. When a session is opened or resumed, the adapter resolves the user from the channel identity and attaches it to the session context.

Role changes and identity linking take effect on the next session open (e.g. next message in a new or resumed session).

Per-message resolution (needed for group chats with mixed roles) is deferred to the long-term roadmap. See "Future: Per-Message Identity Resolution" below.

### Agent-Facing Management Tools

The owner manages users and sessions through conversation. These tools are only available to `owner` role. They are agent tools (like `memory_add`), not HTTP API endpoints — the agent interprets the owner's natural language intent and calls the appropriate tool.

#### User Management

| Tool | Description |
|------|-------------|
| `user_list` | List all users with their identities and roles |
| `user_identity_link` | Link a channel identity to a specified user. If the identity belongs to another user, migrate it and evaluate merge. |
| `user_identity_unlink` | Remove a channel identity from a user |
| `user_role_set` | Change a user's role (owner/user/guest) |
| `user_merge` | Explicitly merge one user into another (re-link all identities, update attributions, mark old record) |

#### Session Management

| Tool | Description |
|------|-------------|
| `session_list` | List sessions with optional filters (channel, user, date range, keyword). Returns session ID, description, last activity, message count, source. |
| `session_read` | Read message history from a specified session. The agent can review what happened in another session without switching to it. |
| `session_summary` | Get a concise summary of a session (description + working memory + recent activity). Useful when the owner asks "what happened in that Telegram chat?" |

Session management tools let the owner ask the agent questions like:

- "show me recent sessions" → `session_list`
- "what did Bob talk about in his last session?" → `session_list` (filter by user) → `session_read` or `session_summary`
- "what happened in the Telegram group today?" → `session_list` (filter by channel + date) → `session_summary`
- "read me the last 10 messages from session X" → `session_read`

The agent reads other sessions as **read-only context** — it does not switch its own session or inject foreign history into the current conversation. The owner sees the information as part of the current session's response.

## Session Integration

### SessionSpec Change

`SessionSpec` gains an optional `userId`:

```typescript
interface SessionSpec {
  sessionId: string;
  source: SessionSource;
  metadata?: Record<string, MetadataValue>;
  userId?: string;  // resolved user, if known
}
```

The `userId` is resolved by the adapter or API layer when the session is opened. The agent runtime uses it to:

- determine role and filter available tools
- scope memory queries (future: per-user memory isolation)

### Session Routing

How users map to sessions depends on the channel:

| Channel | Default Routing | Session ID Pattern |
|---------|----------------|-------------------|
| CLI | Owner uses any session | User-selected or auto |
| Web | Owner uses any session | User-selected or auto |
| Telegram DM | One session per user per chat | `tg:{chatId}` |
| Telegram group | One session per group | `tg:{chatId}` (shared) |
| API | Caller specifies | Caller-provided |

## Store Interface

New interface added to `InternalStateStore`:

```typescript
interface UserStore {
  /** Create or update a user record. */
  upsert(scope: StoreScope, user: UserRecord): Promise<void>;

  /** Get a user by ID. */
  get(scope: StoreScope, userId: string): Promise<UserRecord | undefined>;

  /** List all users. */
  list(scope: StoreScope): Promise<UserRecord[]>;

  /** Link a channel identity to a user. */
  linkIdentity(scope: StoreScope, identity: UserIdentity): Promise<void>;

  /** Resolve a channel identity to a user ID. */
  resolve(scope: StoreScope, channel: string, channelUserId: string): Promise<string | undefined>;

  /** Remove a channel identity link. */
  unlinkIdentity(scope: StoreScope, channel: string, channelUserId: string): Promise<void>;

  /** Delete a user and all their identities. */
  delete(scope: StoreScope, userId: string): Promise<void>;

  /** Mark a user as merged into another. Re-links identities, updates session/message refs. */
  merge(scope: StoreScope, fromUserId: string, intoUserId: string): Promise<void>;

  /** List identities for a given user. */
  listIdentities(scope: StoreScope, userId: string): Promise<UserIdentity[]>;
}
```

Types:

```typescript
interface UserRecord {
  userId: string;
  role: 'owner' | 'user' | 'guest';
  name?: string;
  mergedInto?: string;
  createdAt: string;
  updatedAt: string;
}

interface UserIdentity {
  userId: string;
  channel: string;
  channelUserId: string;
  createdAt: string;
}
```

Added to `InternalStateStore`:

```typescript
interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryProvider;
  containers: ContainerStore;
  instructions: InstructionStore;
  users: UserStore;
  close(): Promise<void>;
}
```

## Implementation Status

### Phase 1: Core ✅ Completed

1. ✅ **Schema migration** — `users` and `user_identities` tables with `merged_into` column (migration 14)
2. ✅ **UserStore** — `DbUserStore` with resolve, link, merge operations
3. ✅ **Wire into InternalStateStore** — `users` field added
4. ✅ **Identity resolution in agent runtime** — resolve userId per-session (including existing sessions on re-open), attach to session context
5. ✅ **Tool filtering by role** — filter tool set based on resolved user's role; `refreshAgentConfiguration` also respects role
6. ✅ **CLI/web bootstrap** — auto-create owner on first connection (using OS username as identity)
7. ✅ **User management tools** — `user_list`, `user_identity_link`, `user_identity_unlink`, `user_role_set`, `user_merge` (owner-only)
8. ✅ **System prompt** — multi-user aware preamble; per-user memory namespacing (`user/{userId}/…`); current user context section; agent identity under `agent/…`
9. ✅ **Telegram identity** — Telegram bridge passes metadata (chat_id, username, first_name) on all session opens including `/start`; auto-guest creation for unknown Telegram users

### Phase 1b: Completed

- ✅ **Session management tools** — `session_list`, `session_read`, `session_summary` (owner-only)
- **Unknown user policy config** — `auto_guest` is hardcoded; `reject` and `require_approval` policies not yet configurable

### Phase 2: Multi-channel

- **Identity linking flow** — owner links identities through conversation, merge semantics (tools exist, flow not yet tested end-to-end)
- **DM pairing** — code-based approval flow for `require_approval` unknown user policy (inspired by Hermes)

### Long-Term Roadmap

These features are deferred but inform the current design (we avoid painting ourselves into a corner):

- **Session capabilities** — each session carries a configured set of tool categories ("what the agent is equipped with"), separate from role permissions ("what the user is allowed to use"). The effective tool set becomes `session capabilities ∩ role permissions`. Default capability sets vary by channel (CLI gets everything, Telegram DM gets memory + web, groups get web only). Owner can adjust per session through conversation. This prevents unnecessary tools from wasting context and reduces surface area.
- **Per-message identity resolution** — needed for group chats where multiple users with different roles share a session. Currently identity is resolved per-session. Per-message resolution requires adding `userId` to `SessionHistoryMessage` and making `refreshAgentConfiguration()` accept the current user to adjust tools per turn.
- **Per-message tool filtering in group chats** — the full group chat scenario (owner/user/guest in the same Telegram group with different tool sets per message) depends on per-message resolution.
- **Per-user tool overrides** — fine-grained allow/deny rules beyond the three-role model. Can be layered as a third filter: `effective = session ∩ role ∩ user_overrides`.
- **User ID hashing for LLM privacy** — Hermes hashes user IDs (SHA-256, 12-char) before sending to LLMs on privacy-sensitive platforms. Worth considering for hosted deployments.
- **Session routing strategies** — configurable per-user session isolation in groups (Hermes-style `group_sessions_per_user`) vs shared session with attribution (current design). Could be a per-channel config option.

## Comparison with Existing Projects

### Hermes (NousResearch/hermes-agent)

Hermes uses a single-owner trust model with binary authorization (approved / denied). Key differences:

| Aspect | Hermes | OpenHermit |
|--------|--------|------------|
| Identity | Platform-native IDs, no cross-channel linking | `user_identities` table with cross-channel linking + merge |
| Roles | Binary (approved / not) | Three-tier (owner / user / guest) |
| Tool filtering | Per-platform toolsets, same for all users | Role-based (session capabilities planned) |
| Group sessions | Per-user isolation (`group_sessions_per_user`) | Shared session (per-message attribution deferred) |
| Authorization | Allowlist chain + DM pairing codes | Unknown user policy + owner conversation linking |
| Privacy | User ID hashing before LLM | Deferred |

Hermes's DM pairing flow is worth adopting for `require_approval` policy.

### OpenClaw

OpenClaw has richer auth primitives (device pairing, token, trusted proxy) but the same single-owner, no-RBAC limitation.

| Aspect | OpenClaw | OpenHermit |
|--------|----------|------------|
| Identity | Identity Resolver skill (mapping only) | Full identity table with merge + lifecycle |
| Roles | owner / non-owner (binary) | owner / user / guest |
| Tool filtering | Owner-only gating | Role-based (session capabilities planned) |
| RBAC | Requested but unimplemented (#8081) | Designed from the start |

### Claude Code

Claude Code has no user identity model but the most sophisticated tool permission system (allow/deny/ask rules with glob patterns, layered precedence). OpenHermit's planned session capabilities draw from a similar idea — scoping what tools are available in a given context — but driven by session configuration rather than static rule files.

## Relationship to Existing Docs

- **session-model.md** — sessions gain optional `userId` field
- **memory-model.md** — memory system unchanged; user profiles stored as regular memory entries with `user/{userId}/` prefix
- **channel-adapter.md** — adapters gain responsibility for extracting `(channel, channelUserId)` from platform messages
- **participant-model.md** — superseded by this document; can be archived
