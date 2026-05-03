# E2B Backend Design For OpenHermit

This document proposes an `e2b` exec backend for OpenHermit.

Date: 2026-05-02

## Goal

Add E2B as a new execution backend type so an agent can:

- run commands inside an E2B sandbox instead of a local shell or Docker container
- keep sandbox state with `pause` / `resume`
- persist installed software and runtime filesystem state across pauses
- support a durable workspace path inside the sandbox
- inject shared files such as `/skills`

This is an execution-backend integration plan, not a full file-tools design.

## Why E2B

E2B matches the near-term requirement better than the current Docker model in one important way:

- it natively supports `pause` / `resume`, preserving both filesystem and memory state

According to the official docs:

- pause preserves the sandbox filesystem and memory state
- paused sandboxes can be resumed later by ID
- auto-pause can be enabled with lifecycle settings
- runtime-installed packages only exist in that sandbox instance unless baked into a template
- volumes exist independently of sandbox lifecycle, but are currently in private beta

References:

- [Sandbox persistence](https://e2b.dev/docs/sandbox/persistence)
- [Sandbox snapshots](https://e2b.dev/docs/sandbox/snapshots)
- [Install custom packages](https://e2b.dev/docs/quickstart/install-custom-packages)
- [Volumes](https://e2b.dev/docs/volumes)
- [Mounting volumes](https://e2b.dev/docs/volumes/mount)
- [List sandboxes](https://e2b.dev/docs/api-reference/sandboxes/list-sandboxes)
- [Sandbox filesystem SDK](https://e2b.dev/docs/sdk-reference/js-sdk/v2.14.1/sandbox-filesystem)

## Current OpenHermit Model

Today OpenHermit has:

- `ExecBackendManager` with `docker` and `local` backends
- `DockerContainerManager` which bind-mounts `AgentWorkspace.root` to `/workspace`
- `AgentWorkspace` on the host, used as the durable workspace source of truth

That works well for host-managed files, but it assumes:

- the execution environment can see the same host directory
- workspace persistence is external to the compute backend

E2B changes that assumption. The sandbox is remote and stateful. Host bind mounts are not available.

## Design Decision

For the E2B backend, make the sandbox the execution boundary and make persistence explicit:

- sandbox lifecycle handles runtime state
- workspace persistence is inside the sandbox filesystem for v1
- `/skills` are injected into the sandbox on startup or first use
- software needed on every sandbox should come from a custom E2B template

Do not try to preserve the current host-bind-mount mental model.

## V1 Scope

V1 should support:

- create or reconnect to a sandbox for an agent
- run shell commands in the sandbox
- auto-pause on idle
- resume by sandbox ID
- keep runtime-installed software across pause/resume
- create `/workspace`
- inject `/skills` into the sandbox filesystem
- store enough metadata to reconnect later

V1 should not depend on E2B Volumes.

Reason:

- E2B volumes are currently documented as private beta
- OpenHermit should not make beta storage a hard dependency for the first integration

## Persistence Model

### Workspace

For v1, define the agent workspace path inside the sandbox as:

```text
/workspace
```

This becomes the effective working directory for `exec`.

Persistence behavior:

- if the sandbox is paused and later resumed, `/workspace` is preserved
- if the sandbox is killed, `/workspace` is lost unless reconstructed

Implication:

- v1 treats an E2B sandbox as a long-lived agent machine, not a disposable worker

### Installed Software

Two classes of software should be treated differently:

1. Base software

Examples:

- git
- ripgrep
- node
- python
- language runtimes needed by most tasks

These should be baked into a custom E2B template.

2. Runtime software

Examples:

- ad hoc `apt-get install`
- project-specific package installs

These can persist across pause/resume, but should not be relied on after kill/recreate.

### Skills

OpenHermit currently exposes DB-managed skills to Docker as `/skills:ro`.

E2B has no host bind mount equivalent in the public docs. For v1:

- copy skills into the sandbox filesystem
- place them under `/skills`
- set directory and file permissions to read-only after write

Recommended behavior:

- sync `/skills` when the sandbox is first created
- re-sync when the enabled skill set changes
- use a manifest file under `/var/openhermit/skills-manifest.json` or similar to detect drift

Because the filesystem SDK exposes file metadata but not a dedicated permission mutation API in the referenced page, permission hardening should be done through command execution, for example:

```sh
chmod -R a-w /skills
find /skills -type d -exec chmod 555 {} \;
find /skills -type f -exec chmod 444 {} \;
```

This is policy-level read-only, not a platform-enforced mount-level read-only guarantee.

## Sandbox Lifecycle

Each agent should map to at most one active E2B sandbox in v1.

Lifecycle:

1. Agent session needs `exec`
2. Backend checks whether an E2B sandbox ID exists for the agent
3. If yes, reconnect to it
4. If paused, reconnect resumes it
5. Run command
6. Let E2B auto-pause after timeout

Recommended E2B lifecycle settings:

```ts
lifecycle: {
  onTimeout: 'pause',
  autoResume: true,
}
```

Notes:

- E2B docs state the default timeout is 5 minutes unless overridden
- after resume, the timeout resets

## OpenHermit Backend Shape

Add a new backend type:

```ts
export interface E2BExecBackendConfig {
  id?: string
  type: 'e2b'
  label?: string
  template: string
  timeout_ms?: number
  sandbox_timeout_ms?: number
  cwd?: string
}
```

Suggested meaning:

- `template`: E2B template name to create sandboxes from
- `timeout_ms`: max time for a single `exec` call from OpenHermit’s point of view
- `sandbox_timeout_ms`: E2B idle timeout before auto-pause
- `cwd`: default working directory inside the sandbox, default `/workspace`

Add a backend implementation:

- `E2BExecBackend` in `apps/agent/src/core/exec-backend.ts` or a sibling file

It should implement the existing `ExecBackend` contract:

- `ensure()`
- `exec(command)`
- `shutdown()`

## Required Runtime State

OpenHermit needs to remember sandbox identity across process restarts.

Recommended minimal state per agent/backend:

```ts
type E2BBackendState = {
  sandboxId: string
  template: string
  cwd: string
  skillsRevision?: string
  updatedAt: string
}
```

This should not live only in memory.

Suggested storage options:

- add a small backend-state table in PostgreSQL
- or extend existing internal state for runtime backends

V1 requirement:

- gateway restart must not orphan every E2B sandbox

## Workspace Strategy Options

There are three possible workspace strategies.

### Option A: Sandbox filesystem as workspace

This is the recommended v1 choice.

Pros:

- simplest integration
- fully aligned with E2B pause/resume
- no beta dependency

Cons:

- kill loses workspace unless separately exported
- workspace is tied to one sandbox identity

### Option B: E2B volume mounted at `/workspace`

Not recommended for v1.

Pros:

- workspace survives kill/recreate
- cleaner separation of compute and data

Cons:

- volumes are private beta
- introduces a storage dependency before the core backend is proven

### Option C: Host remains source of truth and syncs into sandbox

Do not use for the E2B backend.

Pros:

- superficially resembles current Docker model

Cons:

- remote sync complexity
- two sources of truth
- poor consistency model
- defeats the point of using a stateful sandbox backend

## Skills Injection Plan

For v1, use write-then-lock:

1. gather enabled DB-managed skill contents on the host
2. serialize/copy them into the sandbox under `/skills/<skillId>/...`
3. write a manifest describing the expected files and checksums
4. run a permission-hardening command to make `/skills` read-only

When to sync:

- sandbox creation
- agent startup if skill assignment revision changed
- explicit admin-triggered resync

Failure policy:

- if skills sync fails, backend `ensure()` should fail
- do not allow partially-synced `/skills` to be used silently

## Command Execution Model

E2B supports command execution directly through the SDK.

OpenHermit should continue exposing a plain shell command interface to the model:

- `exec.command` remains a shell string
- backend runs it inside the sandbox
- backend captures stdout, stderr, exit code, duration

Working directory:

- default to `/workspace`
- if `cwd` is configured, use that instead

The backend should avoid mutating user-visible shell state between calls.

## Proposed Implementation Plan

### Phase 1: Backend skeleton

- add `e2b` config type to the exec backend config union
- add an `E2BExecBackend` implementation
- initialize E2B SDK with API key from `process.env.E2B_API_KEY` (platform-level)
- create sandbox from template
- reconnect by stored sandbox ID
- run commands

### Phase 2: Durable backend state

- persist `sandboxId` and backend metadata
- restore connection after gateway restart
- handle sandbox-not-found by recreating cleanly

### Phase 3: Workspace bootstrap

- ensure `/workspace` exists
- set backend working directory
- write a small OpenHermit marker file, for example:

```text
/workspace/.openhermit/backend.json
```

### Phase 4: Skills sync

- copy skills into `/skills`
- add manifest and revision tracking
- set permissions read-only

### Phase 5: Operational hardening

- reconcile leaked sandboxes
- surface sandbox state in logs/status
- expose admin tooling to inspect sandbox IDs and force recreate

## Failure Modes To Handle

### Sandbox ID exists but sandbox was killed

Behavior:

- detect not found on reconnect
- create a new sandbox
- bootstrap workspace and skills again
- clear old state

### Skills changed while sandbox is paused

Behavior:

- compare stored `skillsRevision` with current revision
- if changed, resume or connect sandbox
- re-sync `/skills`

### Gateway restarts while sandbox remains paused

Behavior:

- recover sandbox ID from persisted backend state
- reconnect on next `exec`

### Long idle agents

Behavior:

- rely on E2B auto-pause
- do not eagerly kill unless an explicit cleanup policy is added

## Security Notes

- API key is platform-level (`E2B_API_KEY` env var loaded from `~/.openhermit/.env`), not per-agent
- sandbox IDs should be treated as runtime capability identifiers
- `/skills` read-only in v1 is best-effort filesystem policy, not a mount-level guarantee
- workspace isolation is per sandbox, not per host directory

## Operational Tradeoffs

Advantages over Docker backend:

- no host container density problem for idle agents
- native pause/resume
- runtime-installed software survives resume
- no dependency on host-mounted workspace directories

Disadvantages:

- workspace durability in v1 depends on keeping the sandbox alive via pause, not kill
- `/skills` are copied, not mounted
- backend state persistence becomes mandatory
- external platform dependency and API quota/cost considerations

## Recommended V1 Decision

Use this exact model for the first E2B backend:

- one E2B sandbox per agent
- custom template with common tools preinstalled
- `/workspace` lives in sandbox filesystem
- sandbox auto-pauses on idle
- sandbox resumes on next `exec`
- `/skills` are copied into the sandbox and then permission-locked
- no E2B volumes in v1

This gives OpenHermit a coherent first integration without depending on beta storage features.

## Follow-Up V2

If v1 is successful, v2 can add optional E2B volume support:

- mount a volume at `/workspace`
- allow kill/recreate without losing workspace
- separate workspace durability from sandbox identity

That should be a later optimization, not the starting point.

## Resolved Questions

### 1. Where should E2B backend state be persisted?

Use the existing `agents` table — add a `backend_state` JSONB column.

Schema:

```sql
ALTER TABLE agents ADD COLUMN backend_state jsonb;
```

Content per agent:

```json
{
  "e2b": {
    "sandboxId": "sbx_abc123",
    "template": "openhermit-base",
    "cwd": "/workspace",
    "skillsRevision": "2026-05-02T10:00:00Z",
    "updatedAt": "2026-05-02T10:05:00Z"
  }
}
```

Keyed by backend type so an agent could theoretically have state for multiple backend types.

### 2. What is the canonical skillsRevision source?

Use the latest `updated_at` timestamp from the agent's enabled skill assignments. This is already queryable from `DbSkillStore.listEnabled(agentId)`. A content hash is more precise but adds complexity for v1 — timestamp is good enough because skill content changes always bump `updated_at`.

### 3. Should OpenHermit expose sandbox IDs in admin APIs?

Yes. Add sandbox state to the existing fleet endpoint (`GET /api/admin/agents/fleet`). Each agent entry should include:

```json
{
  "backend": {
    "type": "e2b",
    "sandboxId": "sbx_abc123",
    "status": "running" | "paused" | "unknown"
  }
}
```

Also add an admin action to force-recreate: `POST /api/admin/agents/:agentId/sandbox/recreate`.

### 4. Do we want a cleanup policy for paused sandboxes older than N days?

Not in v1. E2B has its own retention policy for paused sandboxes (24 hours by default). If an agent's sandbox expires, the reconnect-on-missing logic handles it by creating a new one. A cleanup sweep can be added in v2 if orphan sandboxes become a cost issue.

### 5. Should shutdown() pause or kill by default?

**Pause.** This preserves workspace state and installed software. Kill should only happen on explicit admin action (force-recreate) or agent deletion. Map the existing lifecycle policies:

| OpenHermit lifecycle | E2B action |
|---------------------|------------|
| `shutdown()` (normal) | pause |
| Agent deleted | kill |
| Admin force-recreate | kill + create |
| E2B idle timeout | auto-pause (E2B native) |

## Integration Points — File-Level Checklist

Files that need changes:

| File | Change |
|------|--------|
| `apps/agent/src/core/exec-backend.ts` | Add `E2BExecBackendConfig`, `E2BExecBackend` class, register factory |
| `apps/agent/src/core/security.ts` | Add `E2BBackendSchema` to Zod discriminated union |
| `apps/agent/src/core/types.ts` | No changes needed — `ExecConfig` is generic |
| `apps/agent/package.json` | Add `e2b` dependency |
| `packages/store/src/schema.ts` | Add `backend_state` column to agents table |
| `packages/store/src/impl/agent-store.ts` | Add `getBackendState` / `setBackendState` methods |
| `packages/store/drizzle/` | New migration for `backend_state` column |
| `apps/gateway/src/app.ts` | Surface sandbox state in fleet endpoint, add recreate endpoint |

## Minimal Claude Tasking Prompt

If this document is handed to Claude for implementation, the first implementation step should be:

1. add `e2b` to the exec backend config union and Zod schema
2. implement `E2BExecBackend` with create/reconnect/exec/pause support
3. add `backend_state` JSONB column to agents table, with store methods
4. persist sandbox ID per agent, restore on gateway restart
5. set `/workspace` as cwd
6. leave volumes and skills sync out of first PR
7. add tests for reconnect, recreate-on-missing, and command execution
