# Plugins & Hooks (Design Draft)

This document describes the planned plugin/hook surface. **Phase 0** —
the typed event catalog and per-agent event bus — has landed in
`apps/agent/src/events.ts`. Subsequent phases below are not yet
implemented.

## Why

OpenHermit has several extension points already (skills, MCP servers,
channel adapters, web providers, exec backends), but each is its own
shape. There is no way to inject in-process code that runs at well-defined
points in the agent lifecycle — for example, a fast local tool that
shouldn't pay the MCP round-trip, a policy gate that blocks specific
tool calls beyond what `security.json` expresses, or a side-effect that
fires after every turn (metrics, integrations, audit).

A plugin is the missing piece: a small, named bundle of code that runs
inside the agent runtime and subscribes to lifecycle events.

## Phases

### Phase 0 — Event catalog and bus *(implemented)*

`AgentEventBus` is a per-agent typed event bus. Every running
`AgentRunner` will own one instance. Events are versioned (e.g.
`prompt.assemble@v1`); future schema changes ship as `@v2` so existing
plugins keep working.

Three hook shapes:

| Shape | Return type | Use case |
|-------|-------------|----------|
| `listener` | `void` | Logs, metrics, fire-and-forget side effects |
| `transform` | `payload` | Mutate prompt sections, rewrite tool args, edit channel messages |
| `veto` | `{allow, reason?}` | Block a tool call; finer than `security.json` policy |

Events ordered by priority (lower runs first). Throwing handlers are
dropped from the chain by default and surface as `plugin.error@v1`;
manifests can opt into `failureMode: 'fail'` to abort the turn.

Current event catalog (`apps/agent/src/events.ts`):

```
agent.started@v1                 listener
agent.stopped@v1                 listener
session.opened@v1                listener
session.closed@v1                listener
session.message.received@v1     transform
prompt.assemble@v1              transform
model.before@v1                 transform
model.after@v1                   listener
tool.before@v1                  veto
tool.after@v1                    listener
channel.message.in@v1           transform
channel.message.out@v1          transform
schedule.fired@v1               transform
memory.upsert@v1                 listener
plugin.error@v1                  listener
```

### Phase 1 — Wire the runner *(planned, no behavior change)*

Refactor existing in-runner code (compaction, channel outbound,
schedule trigger, prompt assembly) to emit/transform on the bus.
This is a pure refactor — no new feature, no observable behavior
change. Goal: prove the event payloads are right under real load
before committing to them as a public API.

### Phase 2 — In-process plugin loader *(planned)*

A `plugins` global table + `agent_plugins` per-agent assignment table
(mirroring `agent_skills` / `agent_mcp_servers`, including wildcard
`agent_id = '*'` support). Each plugin is a directory:

```
plugins/my-policy/
  manifest.json
  index.ts        # export register(ctx): void
```

`register(ctx)` receives a scoped API:

- `ctx.bus.on('tool.before@v1', handler, { priority })`
- `ctx.tools.add({ name, schema, handler })` — register an in-process tool
- `ctx.memory`, `ctx.session`, `ctx.logger` — read-only slices of the
  runner state
- **No direct DB access** — mediated through scoped interfaces so
  schema upgrades don't break plugins.

CLI mirrors `skills`:

```bash
hermit plugins list
hermit plugins register <id> --name ... --description ... --path ...
hermit plugins enable <id> --agent <id>
hermit plugins enable <id> --all
hermit plugins disable <id> --all
hermit plugins delete <id>
```

### Phase 3 — Out-of-process plugins via webhook *(planned)*

Reuse the existing channel webhook ingress
(`POST /api/agents/:id/channels/:namespace/webhook`). A plugin
subscription becomes "POST event payload to this URL; expect a
mutation/decision back." This makes plugins language-agnostic and
sandboxable, at the cost of HTTP latency — so it's restricted to
non-hot-path events (`tool.after`, `schedule.fired`,
`session.closed`, `memory.upsert`); hot-path transforms
(`prompt.assemble`, `tool.before`) stay in-process only.

## Design rules (binding for future phases)

1. **Per-agent instance, never singleton.** Plugin state must not leak
   across agents in the same gateway.
2. **Versioned payloads.** `event@v1` is forever; new shapes are
   `event@v2`. Both are dispatched in parallel during the deprecation
   window.
3. **Default failure mode = skip + log.** Plugins must not be able to
   bring down a turn unless they explicitly ask to.
4. **No plugin → DB shortcuts.** All persistence goes through the
   scoped `ctx.*` interfaces. Direct Drizzle access from a plugin is
   a review red flag.
5. **Skills, MCP, plugins are orthogonal.** A skill is prompt content;
   an MCP server is a remote tool catalog; a plugin is in-process
   reactive code. Don't try to unify them — the cost outweighs the
   tidiness.

## Open questions

- **Sandboxing.** Phase 2 runs plugin code in the gateway's Node
  process. Worker threads or vm-isolation can come later if we accept
  user-supplied (vs. admin-vetted) code.
- **Cross-plugin ordering.** Priority ties are broken by registration
  order; explicit dependency declarations may be needed if plugin
  ecosystems develop.
- **Event payload immutability.** Transform handlers currently get
  raw mutable payloads. Frozen payloads (with required clone-on-write)
  would prevent accidental cross-handler mutation but cost a clone per
  hook.
