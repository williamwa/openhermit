import type { SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';

import type {
  CheckpointHistoryRow,
  ContainerRegistryEntry,
  EpisodicLogEntry,
  InstructionEntry,
  MemoryAddInput,
  MemoryEntry,
  MemorySearchOptions,
  MemoryUpdateInput,
  PersistedSessionIndexEntry,
  SessionLogEntry,
  StoreScope,
} from './types.js';

export interface SessionStore {
  upsert(scope: StoreScope, entry: PersistedSessionIndexEntry): Promise<void>;
  get(scope: StoreScope, sessionId: string): Promise<PersistedSessionIndexEntry | undefined>;
  list(scope: StoreScope): Promise<PersistedSessionIndexEntry[]>;
  waitForIdle(): Promise<void>;
}

export interface MessageStore {
  appendLogEntry(scope: StoreScope, sessionId: string, entry: SessionLogEntry): Promise<void>;
  appendEpisodicEntry(scope: StoreScope, sessionId: string, entry: EpisodicLogEntry): Promise<void>;
  writeSessionStarted(scope: StoreScope, spec: SessionSpec, model: { provider: string; model: string }): Promise<void>;
  listHistoryMessages(scope: StoreScope, sessionId: string): Promise<SessionHistoryMessage[]>;
  listCheckpointHistory(scope: StoreScope, sessionId: string): Promise<CheckpointHistoryRow[]>;
  listSessionEntries(scope: StoreScope, sessionId: string): Promise<SessionLogEntry[]>;
  listEpisodicEntries(scope: StoreScope, sessionId: string): Promise<EpisodicLogEntry[]>;
  getSessionWorkingMemory(scope: StoreScope, sessionId: string): Promise<string | undefined>;
  setSessionWorkingMemory(scope: StoreScope, sessionId: string, content: string, updatedAt: string): Promise<void>;
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
  getContextBlock(scope: StoreScope): Promise<string | undefined>;
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

export interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryProvider;
  containers: ContainerStore;
  instructions: InstructionStore;
  close(): void;
}
