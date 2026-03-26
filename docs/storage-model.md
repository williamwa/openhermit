# Storage Model (Draft)

This document is a working draft.

It records a possible storage abstraction direction for OpenHermit.

It is not yet the implemented source of truth.

## Why This Draft Exists

OpenHermit needs to support two very different deployment shapes:

- local or personal use, where plain files are convenient and naturally agent-friendly
- hosted or multi-agent deployment, where database-backed state is easier to manage centrally

That creates pressure to keep the agent-facing state model compatible with file-like access while also allowing non-filesystem backends.

## Design Goal

The design goal is not to force every kind of state into one generic file API.

Instead, OpenHermit should separate:

- agent-facing document access
- runtime-facing internal state storage

This keeps markdown, prompts, and workspace files natural for the agent while preserving strong structure for sessions, memories, and runtime metadata.

## Proposed Layers

### 1. Document Store

The document layer is the agent-facing path and content surface.

It should feel file-like whether the backing store is a filesystem, database, or cloud object store.

Draft interface:

```ts
interface DocumentStore {
  list(path: string): Promise<DocumentEntry[]>;
  stat(path: string): Promise<DocumentStat | null>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<DocumentContent>;
  write(path: string, content: DocumentContent): Promise<void>;
  delete(path: string): Promise<void>;
  move(fromPath: string, toPath: string): Promise<void>;
  search(query: string, options?: DocumentSearchOptions): Promise<DocumentSearchResult[]>;
}
```

This layer is a good fit for:

- workspace files
- identity markdown
- future agent-managed config documents
- selected virtual views of internal state

Possible adapters:

- `FileSystemDocumentStore`
- `DatabaseDocumentStore`
- `ObjectBackedDocumentStore`

### 2. Internal State Store

Internal state should not be flattened into generic files by default.

Many OpenHermit internals are structured runtime objects:

- sessions
- messages
- checkpoints
- memories
- approvals
- runtime inventory

Those should keep domain-specific storage interfaces.

Draft shape:

```ts
interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryStore;
  checkpoints: CheckpointStore;
  runtime: RuntimeStore;
}
```

Possible adapters:

- `SQLiteInternalStateStore`
- `PostgresInternalStateStore`

This preserves structure, indexing, migration control, and explicit lifecycle semantics.

### 3. Virtual State View

If the agent needs file-like access to internal state, OpenHermit can add a virtual document view on top of internal storage.

That view should be treated as a projection, not the primary storage model.

Possible examples:

- `internal://memory/main.md`
- `internal://sessions/{sessionId}/summary.md`
- `internal://participants/{participantId}.md`

This gives the agent a document-native surface without forcing the runtime to persist everything as loose files.

## Why Not One Generic Storage Class

A single `list/read/write/search` abstraction for everything sounds simple, but it creates a few problems:

- session and memory semantics get flattened into weak document operations
- indexing and transactional needs become harder to express
- lifecycle rules become less explicit
- it becomes harder to evolve internal storage independently from agent-facing views

OpenHermit should unify access where it helps the agent, not erase domain boundaries inside the runtime.

## Suggested Deployment Mapping

### Local / Personal

Suggested shape:

- `FileSystemDocumentStore`
- `SQLiteInternalStateStore`

Why:

- files are easy to inspect and edit
- markdown remains natural
- SQLite keeps structured runtime state simple and portable

### Hosted / Multi-Agent

Suggested shape:

- `DatabaseDocumentStore` or object-backed document layer
- `PostgresInternalStateStore`

Why:

- central management is easier
- multiple agents can share platform infrastructure
- operational tooling, backup, and querying improve

This does not require every external artifact to live inside a relational database.
Some external state may still live in object storage or mounted volumes as long as the agent-facing document layer remains consistent.

## Design Principles

If this direction is implemented, these principles should hold:

- agent-facing content should remain path-based and document-native
- internal runtime state should remain strongly typed and domain-specific
- files and database records should be interchangeable only at the right layer
- virtual document views should be projections, not hidden sources of truth
- deployment backend choices should not leak into prompt or tool semantics

## Open Questions

This draft intentionally leaves several questions open:

- should search be a required capability for every document-store adapter, or optional?
- which internal-state views should be exposed as virtual documents, if any?
- how should binary artifacts fit into the document model?
- should workspace external state in hosted mode be object storage plus index rather than pure relational storage?
- how much of the current filesystem-oriented tool surface should be generalized versus kept explicit?

## Current Status

Status: draft only.

Next steps:

1. Keep the current mixed implementation as the baseline.
2. Explore a `DocumentStore` abstraction for external state first.
3. Keep internal state on domain-specific stores rather than collapsing everything into document APIs.
4. Revisit virtual internal-state views only when the agent has a concrete need for them.
