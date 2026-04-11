import type { SessionHistoryMessage, SessionSpec } from '@openhermit/protocol';

import type {
  CheckpointHistoryRow,
  ContainerRegistryEntry,
  EpisodicLogEntry,
  LongTermMemoryInput,
  MemoryEntry,
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
}

export interface MemoryStore {
  getMemory(scope: StoreScope, key: string): Promise<string | undefined>;
  getMemoryEntry(scope: StoreScope, key: string): Promise<MemoryEntry | undefined>;
  setMemory(scope: StoreScope, key: string, content: string, updatedAt: string, metadata?: Record<string, unknown>): Promise<void>;
  recallLongTermMemories(scope: StoreScope, query: string, limit: number, keyPrefix?: string): Promise<MemoryEntry[]>;
  upsertLongTermMemory(scope: StoreScope, input: LongTermMemoryInput): Promise<MemoryEntry>;
  getMainMemory(scope: StoreScope): Promise<string | undefined>;
  getNowMemory(scope: StoreScope): Promise<string | undefined>;
}

export interface ContainerStore {
  readAll(scope: StoreScope): Promise<ContainerRegistryEntry[]>;
  findByName(scope: StoreScope, name: string): Promise<ContainerRegistryEntry | undefined>;
  upsert(scope: StoreScope, entry: ContainerRegistryEntry): Promise<void>;
  updateByName(scope: StoreScope, name: string, updater: (e: ContainerRegistryEntry) => ContainerRegistryEntry): Promise<ContainerRegistryEntry>;
}

export interface InternalStateStore {
  sessions: SessionStore;
  messages: MessageStore;
  memories: MemoryStore;
  containers: ContainerStore;
  close(): void;
}
