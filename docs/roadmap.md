# Roadmap — Toward "Agents, but operable"

This roadmap targets the gap between the current single-agent management story
and the fleet-operability promise on openhermit.ai. `plan.md` tracks
already-shipped features; this document tracks what is still missing for
OpenHermit to be a credible platform for running fleets of agents in
production.

## Guiding principle

Every agent is a service. The gateway is the control plane. An operator with
many agents must be able to **deploy, observe, change, and recover** them as a
fleet — not one at a time.

We prefer composition of small primitives over bespoke platform machinery. If
operators can build a behavior themselves with the existing model
(assignments, skills, scopes), the platform should not invent a new concept
for it.

---

## Milestone 1 — Fleet operations

Make the hero animation real: one action affects N agents, with the same
mental model that already works.

### M1.1 — Wildcard assignment as the universal pattern

The skill assignment table already supports `agent_id = '*'`: a single row in
`agent_skills` matches every agent at query time
(`WHERE agent_id IN ($agentId, '*')`). New agents automatically inherit
wildcard assignments at startup. This is the right model — no fan-out at
write time, no partial-failure semantics, no batch concept.

Generalize it across the platform:

- **Skills** — already done.
- **MCP servers** — verify `mcp_servers` / assignments follow the same
  pattern; if not, port them. UI accepts `*` in the assign-to field exactly
  like skills.
- **Schedules** — wildcard `agent_id` for "run this cron on every agent"
  (e.g. nightly digest, hourly health check). Assignment + scheduler resolve
  agents at trigger time.
- **Skills / MCP runtime sync** — when a wildcard assignment is added or
  removed, refresh every running agent's mounts (already done for skills via
  `syncAffectedAgentSkillMounts`); ensure the same hook exists for MCP.
- **Storage doc** — `docs/storage-model.md` should formally document
  `agent_id = '*'` as the wildcard convention so future tables follow it.

Channels deliberately stay per-agent (each adapter holds its own bot token /
identity). A wildcard channel does not make sense.

**Acceptance:** Adding `standup-digest` with target `*` shows up under every
agent's enabled skills, including agents created afterward, without any extra
operator action. Same for an MCP server. Same for a cron schedule.

### M1.2 — Fleet overview UI

A top-level page in the admin UI listing every agent in one table:

- Columns: status, sessions (24h), last activity, channels, skills count,
  errors (24h).
- Multi-select for bulk actions; each action is just the existing per-agent
  call repeated client-side, or a single wildcard call when the selection is
  "all".
- Replaces the agent-cards view as the default landing page.

**Acceptance:** Operator can see fleet health in one glance, sort by errors,
and reach any single agent's detail view in one click.

### Explicitly NOT in M1

- **No `/fleet/*` API surface.** Existing per-agent endpoints + `*` are
  sufficient.
- **No skill or MCP version field.** Operators who want canary or staged
  rollout publish a second skill (`standup-digest-v2`), assign it to a subset
  of agents, observe, and then either expand the assignment or remove the new
  skill. Two assignments express the intent without any platform-side state
  machine.
- **No Rollout resource.** Same reason — composition of existing primitives
  covers the use case for any reasonable fleet size we care about today.

---

## Milestone 2 — Observability

You cannot operate what you cannot see.

### M2.1 — Metrics

- Gateway exposes `/metrics` in Prometheus format.
- Per-agent labels: turns, tokens (in/out), tool calls, channel messages,
  error counts, p50/p95 turn latency.
- Sparkline data in the fleet overview UI is sourced from the same metrics,
  not fabricated.

**Acceptance:** Scraping `/metrics` shows real time-series data; the admin UI
sparklines reflect actual traffic.

### M2.2 — Cross-agent audit log

- A query API on top of `session_events` filterable by `agent_id`, `user_id`,
  `channel`, `event_type`, time range.
- Admin UI page "Activity" with filters and a streaming tail mode.
- CLI: `hermit logs --agent one --since 1h --grep error`.

**Acceptance:** From a single page, an operator can find every action a given
user took across all agents in the last week.

### M2.3 — Health endpoints

- Each agent reports a structured health blob: model reachable, exec backend
  reachable, channels connected, scheduler running.
- Gateway `/health` aggregates fleet health into a single OK/DEGRADED/DOWN
  summary.
- Admin UI shows a fleet health pill at the top of every page.

**Acceptance:** Stopping the Docker daemon flips one agent's exec backend to
DOWN, the gateway summary to DEGRADED, and the UI surfaces it without a
manual refresh.

---

## Milestone 3 — Declarative deploy

This is the line between "production service" and "manually-edited JSON."

### M3.1 — `agents.yaml` reconciliation

- New CLI: `hermit apply -f agents.yaml`. The file is the source of truth for
  a set of agents: model, skills (including `*` wildcard assignments), MCP
  servers, channels, schedules, secrets refs.
- Apply diffs against the current DB state and reconciles: create / update /
  delete agents, install / uninstall skills, etc.
- `hermit diff -f agents.yaml` shows a dry-run plan.
- `hermit drift` reports anything in the DB not represented in the manifest.

**Acceptance:** An operator can check `agents.yaml` into git, change a model
version on one agent, run `hermit apply`, and see exactly that one update
applied.

### M3.2 — Org-level secrets

- Replace per-agent `secrets.json` with a shared encrypted store (DB column
  encrypted at rest, key from env or KMS).
- Manifests reference secrets by name (`secretRef: TELEGRAM_TOKEN`); multiple
  agents can share one secret.
- Audit log entry on every secret read.

**Acceptance:** Rotating a Telegram bot token is a single update that takes
effect for every agent referencing it, with an audit trail.

### M3.3 — Supervisor & auto-recovery

- Gateway-side supervisor for agent runners: crash → restart with exponential
  backoff, with a circuit breaker after N failures in a window.
- Channel adapters reconnect on transient failures uniformly across Telegram
  / Discord / Slack and surface state in metrics.
- Postgres reconnect logic in the gateway so a database blip does not require
  a manual gateway restart (we hit this in practice — restoring the DB
  container should be enough).

**Acceptance:** Killing the Postgres container and then restarting it results
in the gateway and all agents recovering automatically within ~30 seconds.

---

## Milestone 4 — Collaboration & multi-tenancy

Operability for teams, not just one root user.

### M4.1 — Multiple owners / admins

- Owner role today is a single account. Allow promoting other users to admin
  with full management rights.
- Audit log entries record actor on every mutation.
- UI: "Members" page to invite / promote / demote.

### M4.2 — Service accounts & API tokens

- First-class non-human principals with scoped tokens
  (e.g. `agents:one:read`, `skills:write`).
- Tokens are issued via CLI / UI, revocable, and show last-used timestamps.

### M4.3 — Per-agent ACLs

- Restrict which users / service accounts can manage which agents.
- Enables a single gateway to host agents owned by different teams.

---

## Out of scope (for now)

These are valuable but deliberately deferred until the milestones above land:

- Hosted / managed offering (cloud control plane).
- Multi-region replication of the gateway.
- Cost / billing primitives.
- Per-agent autoscaling beyond Docker container lifecycle.

---

## Sequencing

The suggested order is M1 → M2 → M3 → M4. The reasoning:

- **M1** turns the brand promise into reality and is the most visible to
  users evaluating the project. It is also the smallest milestone — most of
  the wildcard mechanism already exists for skills; the work is generalizing
  the pattern and shipping the fleet overview UI.
- **M2** is a hard prerequisite for anyone running this in production —
  without it, the fleet is a black box.
- **M3** is what separates "demo" from "service" and naturally builds on the
  declarative wildcard assignments from M1.
- **M4** unlocks team adoption but assumes the single-operator story is
  already polished.
