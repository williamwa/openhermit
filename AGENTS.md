# OpenHermit Workspace Rules

This file defines baseline collaboration rules for agents working in this repository.

## General

- Prefer small, incremental changes over large rewrites unless the task explicitly requires a redesign.
- Keep behavior changes aligned with the current documented architecture before introducing new abstractions.
- When changing a core flow, update the corresponding docs in `README.md` and `docs/` in the same branch.
- Do not preserve legacy compatibility unless the user explicitly asks for it.

## Code Changes

- Prefer clear module boundaries over oversized files.
- Reuse existing helpers and shared abstractions before introducing new patterns.
- Keep internal state and external state clearly separated.
- Avoid adding hidden fallback paths that make behavior harder to reason about.

## Testing

- Run relevant tests after meaningful code changes.
- For broad refactors or runtime changes, run:
  - `npm run typecheck`
  - `npm test`
- Do not claim a fix is complete if the affected tests were not run.

## Commits

- Use English commit messages.
- Keep commit messages concise and descriptive.
- Prefer the format: `<type>: <summary>`
- Common types:
  - `feat`
  - `fix`
  - `refactor`
  - `test`
  - `docs`
  - `chore`
- Keep unrelated changes in separate commits.
- Commit only after tests relevant to the change pass.

## Docs

- Use relative links in repository markdown files.
- Keep docs aligned with the current implementation, not old plans.
- Maintain one current source of truth instead of parallel versioned docs unless explicitly requested.
