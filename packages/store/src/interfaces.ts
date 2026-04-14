import type { SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';

import type {
  CheckpointHistoryRow,
  ContainerRegistryEntry,
  InstructionEntry,
  MemoryAddInput,
  MemoryEntry,
  MemorySearchOptions,
  MemoryUpdateInput,
  PersistedSessionIndexEntry,
  SessionLogEntry,
  StoreScope,
  UserIdentity,
  UserRecord,
} from './types.js';

export interface SessionStore {
  upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void>;
  get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined>;
  list(scope: StoreScope): Promise<PersistedSessionIndexEntry[]>;
  updateDescription(scope: StoreScope, sessionId: string, description: string, source: 'fallback' | 'ai'): Promise<void>;
  waitForIdle(): Promise<void>;
}

export interface MessageStore {
  appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<void>;
  writeSessionStarted(scope: StoreScope, spec: SessionSpec, model: { provider: string; model: string }): Promise<void>;
  listHistoryMessages(scope: StoreScope, sessionId: string): Promise<SessionHistoryMessage[]>;
  listCheckpointHistory(scope: StoreScope, sessionId: string): Promise<CheckpointHistoryRow[]>;
  listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]>;
  getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined>;
  setSessionWorkingMemory(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void>;
  listRecentMessages(scope: StoreScope, sessionId: string, limit: number): Promise<CheckpointHistoryRow[]>;
  listSessionEntriesSinceLastCompaction(scope: StoreScope, sessionId: string): Promise<{ compactionSummary: string | undefined; entries: SessionLogEntry[] }>;
  getCompactionSummary(scope: StoreScope, sessionId: string): Promise<string | undefined>;
  setCompactionSummary(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void>;
}

export interface MemoryProvider {
  readonly name: string;
  initialize(scope: StoreScope): Promise<void>;
  shutdown(): Promise<void>;
  add(scope: StoreScope, input: MemoryAddInput): Promise<MemoryEntry>;
  search(scope: StoreScope, query: string, options?: MemorySearchOptions): Promise<MemoryEntry[]>;
  get(scope: StoreScope, id: string): Promise<MemoryEntry | undefined>;
  update(scope: StoreScope, id: string, input: MemoryUpdateInput): Promise<MemoryEntry>;
  delete(scope: StoreScope, id: string): Promise<void>;
  getContextBlock(scope: StoreScope, options?: { limit?: number | undefined }): Promise<string | undefined>;
}

export interface ContainerStore {
  readAll(scope: StoreScope): Promise<ContainerRegistryEntry[]>;
  findByName(scope: StoreScope, name: string): Promise<ContainerRegistryEntry | undefined>;
  upsert(scope: StoreScope, entry: ContainerRegistryEntry): Promise<void>;
  updateByName(scope: StoreScope, name: string, updater: (e: ContainerRegistryEntry) => ContainerRegistryEntry): Promise<ContainerRegistryEntry>;
}

export interface InstructionStore {
  get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined>;
  getAll(scope: StoreScope): Promise<InstructionEntry[]>;
  set(scope: StoreScope, key: string, content: string, updatedAt: string): Promise<void>;
}

export interface UserStore {
  /** Create or update a user record. */
  upsert(scope: StoreScope, user: UserRecord): Promise<void>;

  /** Get a user by ID. Returns undefined if not found or if merged. */
  get(scope: StoreScope, userId: string): Promise<UserRecord | undefined>;

  /** List all active users (excludes merged records). */
  list(scope: StoreScope): Promise<UserRecord[]>;

  /** Link a channel identity to a user. */
  linkIdentity(scope: StoreScope, identity: UserIdentity): Promise<void>;

  /** Resolve a channel identity to a user ID. Follows merged_into if needed. */
  resolve(scope: StoreScope, channel: string, channelUserId: string): Promise<string | undefined>;

  /** Remove a channel identity link. */
  unlinkIdentity(scope: StoreScope, channel: string, channelUserId: string): Promise<void>;

  /** List identities for a given user. */
  listIdentities(scope: StoreScope, userId: string): Promise<UserIdentity[]>;

  /** Mark a user as merged into another. Re-links all identities to the target. */
  merge(scope: StoreScope, fromUserId: string, intoUserId: string): Promise<void>;

  /** Delete a user and all their identities. */
  delete(scope: StoreScope, userId: string): Promise<void>;
}

export interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryProvider;
  containers: ContainerStore;
  instructions: InstructionStore;
  users: UserStore;
  close(): void;
}
