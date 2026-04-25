# User Model

OpenHermit identifies users through channel identities and grants permissions through per-agent roles.

## Data Model

| Table | Purpose |
|-------|---------|
| `users` | user ID, display name, merge target, timestamps |
| `user_identities` | maps `(channel, channel_user_id)` to `user_id` |
| `user_agents` | role for a user on an agent |

Roles:

- `owner`: full management and tool access
- `user`: standard interaction access
- `guest`: limited access for unknown or low-trust identities

## Identity Resolution

A caller identity is:

```ts
interface CallerIdentity {
  channel: string;
  channelUserId: string;
}
```

Examples:

- `cli` + OS username
- `web` + device fingerprint
- `telegram` + Telegram user ID
- `discord` + Discord user ID
- `slack` + Slack user ID

When a session opens or a message includes a sender, the runner resolves the identity to a user. Channel adapters can auto-create unknown identities as guests. The owner can later link, unlink, merge, or change roles.

## Owner Bootstrap

The first trusted CLI/web identity can bootstrap ownership for an agent. Created agents may also receive an explicit `ownerUserId`.

## Session Participation

Sessions store `userIds`. Non-owner users can only read/resume sessions where they are participants. Owners can read all sessions for the agent.

Group channel sessions can include multiple users. The runtime resolves per-message sender identity when channel adapters provide `sender`.

## Tool Access

Toolsets are filtered by role and available stores:

| Role | Effective access |
|------|------------------|
| `owner` | exec, web, memory, instruction, user, session, session_send, schedules, MCP management |
| `user` | web, memory, session read/list/summary, permitted normal interaction |
| `guest` | restricted web/session/schedule read access |

Some tools also require runtime capabilities, such as `scheduleStore`, `userStore`, `sessionStore`, channel outbound adapters, or MCP client manager.

## Agent Tools

Owner-focused user tools:

- `user_list`
- `user_identity_link`
- `user_identity_unlink`
- `user_role_set`
- `user_merge`

Session tools:

- `session_list`
- `session_read`
- `session_summary`
- `session_send`

`session_send` sends proactive messages through registered channel outbound adapters and records `channel_message_sent` events.

## Merge Semantics

`user_merge` redirects one user into another by moving identities and marking the old record's `merged_into`. Resolution follows merge links so old identities continue to map to the canonical user.

## Current Limits

- Role is per agent, not per session.
- Unknown-user policy is currently runtime behavior rather than a separately configurable policy document.
- Fine-grained session capability sets are not implemented; role filtering is the active permission model.
