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

---

## Milestone 1 — Fleet operations

Making the hero animation real: one action affects N agents.

### M1.1 — Fleet-scoped APIs

- New gateway endpoints under `/fleet/*` that accept `agentIds: string[]` (or
  `selector` for label-based targeting later) and fan out to each agent.
- First targets: `POST /fleet/skills/install`, `POST /fleet/skills/uninstall`,
  `POST /fleet/mcp/install`, `POST /fleet/channels/enable`,
  `POST /fleet/channels/disable`.
- Per-agent failures must not block the rest. Response is
  `{ results: [{ agentId, status, error? }] }`.

**Acceptance:** `hermit skills install standup-digest --all` installs the skill
across every running agent and reports per-agent outcomes; a single failing
agent does not abort the operation.

### M1.2 — Fleet overview UI

- New top-level page in the admin UI: a sortable table of all agents with
  columns for status, sessions (24h), last activity, channels, skills count,
  errors (24h).
- Multi-select with bulk actions wired to the M1.1 endpoints.
- Replaces the "agent list cards" view as the default landing page.

**Acceptance:** Operator can select 5 agents, click "Install skill", choose
`standup-digest`, and confirm; UI shows a per-row progress indicator and final
status without page reload.

### M1.3 — Skill / MCP versioning

- Skills today are filesystem entries. Promote them to a registry table:
  `(name, version, definition_json, created_at)`.
- Assignments record `(agent_id, skill_name, installed_version)`.
- `hermit skills publish ./standup-digest` bumps version; `hermit skills upgrade
  --all` rolls out the latest version with rollback on failure.
- Same shape for MCP servers (config + version pinning).

**Acceptance:** A skill can be edited and republished, and a fleet-wide upgrade
either rolls everyone forward or rolls back if too many agents fail health
checks within a soak window.

---

## Milestone 2 — Observability

You cannot operate what you cannot see.

### M2.1 — Metrics

- Gateway exposes `/metrics` in Prometheus format.
- Per-agent labels: turns, tokens (in/out), tool calls, channel messages, error
  counts, p50/p95 turn latency.
- Sparkline data in the fleet overview UI is sourced from the same metrics, not
  fabricated.

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
DOWN, the gateway summary to DEGRADED, and the UI surfaces it without a manual
refresh.

---

## Milestone 3 — Declarative deploy

This is the line between "production service" and "manually-edited JSON."

### M3.1 — `agents.yaml` reconciliation

- New CLI: `hermit apply -f agents.yaml`. The file is the source of truth for a
  set of agents: model, skills, MCP servers, channels, schedules, secrets refs.
- Apply diffs against the current DB state and reconciles: create / update /
  delete agents, install / uninstall skills, etc.
- `hermit diff -f agents.yaml` shows a dry-run plan.
- Drift detection: `hermit drift` reports anything in the DB not represented in
  the manifest.

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
- Channel adapters reconnect on transient failures (already partial — make it
  uniform across Telegram / Discord / Slack and observable in metrics).
- Postgres reconnect logic in the gateway so a database blip does not require a
  manual gateway restart.

**Acceptance:** Killing the Postgres container, then restarting it, results in
the gateway and all agents recovering automatically within ~30 seconds.

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
  (e.g. `agents:one:read`, `fleet:skills:write`).
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

- **M1** turns the brand promise into reality and is the most visible to users
  evaluating the project.
- **M2** is a hard prerequisite for anyone running this in production —
  without it, the fleet is a black box.
- **M3** is what separates "demo" from "service" and naturally builds on the
  fleet APIs from M1.
- **M4** unlocks team adoption but assumes the single-operator story is
  already polished.

Within each milestone, the sub-items are listed in dependency order.
