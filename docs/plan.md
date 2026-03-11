# Planning Docs

OpenHermit planning is now split into two tracks.

## Tracks

- `v1`: the implementation plan that produced the current codebase
- `v2`: the next planning track, starting from the current implementation but changing some core boundaries

## Documents

- Current implementation baseline: [docs/v1/plan.md](v1/plan.md)
- Next planning track: [docs/v2/plan.md](v2/plan.md)

## Why The Split Exists

The original plan assumed:

- file-based memory inside each workspace
- schedule-like behavior attached to the agent runtime

The next iteration is expected to move:

- memory into a program-level store
- scheduling into a program-level scheduler
- more control-plane responsibilities outside the per-agent runtime
