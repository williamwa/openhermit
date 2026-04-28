# Open Questions

These are current product/architecture decisions that are not fully settled.

## Deployment And Migrations

`hermit setup` applies repository-local SQL migrations. The published package needs a clearer production migration story, including idempotent upgrades and operator visibility.

## Session Capabilities

Roles are implemented. Fine-grained per-session capability sets are not. The open question is whether sessions should explicitly declare allowed tool categories, especially for group channels.

## Hosted Secrets

Agent secrets are stored in the encrypted `agent_secrets` table; MCP headers (DB-managed) can include sensitive values that are not currently routed through the same encryption path. Hosted deployments need a unified secret-store integration model (KMS-backed keys, per-org scoping, audit logs on read).

## External Channel Adapter API

Built-in channels are implemented. External adapters can use channel tokens and the SDK, but the formal adapter-author contract is not yet documented as a stable public API.

## Observability

Gateway logs and stats exist. Open questions remain around metrics, traces, per-agent health history, and failure alerting.
