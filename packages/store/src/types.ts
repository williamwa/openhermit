import type {
  MetadataValue,
  SessionHistoryMessage,
  SessionSource,
  SessionSpec,
} from '@openhermit/protocol';

export interface StoreScope {
  agentId: string;
}

export const STANDALONE_AGENT_ID = '__standalone__';

export const standaloneScope: StoreScope = { agentId: STANDALONE_AGENT_ID };

export interface PersistedSessionIndexEntry {
  sessionId: string;
  source: SessionSource;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  completedTurnCount?: number;
  lastSummarizedHistoryCount?: number;
  lastSummarizedTurnCount?: number;
  lastSummarizedAt?: string;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
  metadata?: Record<string, MetadataValue>;
}

export interface SessionLogEntry {
  ts: string;
  role: 'system' | 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'error';
  type?: string;
  [key: string]: unknown;
}

export interface EpisodicLogEntry {
  ts: string;
  session: string;
  type: string;
  data: Record<string, unknown>;
}

export interface MemoryEntry {
  memoryKey: string;
  content: string;
  title?: string;
  tags?: string[];
  updatedAt: string;
}

export interface LongTermMemoryInput {
  key: string;
  content: string;
  title?: string;
  tags?: string[];
  updatedAt: string;
  kind?: string;
}

export type ContainerType = 'ephemeral' | 'service' | 'workspace';

export type ContainerStatus =
  | 'created'
  | 'running'
  | 'stopped'
  | 'exited'
  | 'removed'
  | 'unknown';

export interface ContainerRegistryEntry {
  id: string;
  name: string;
  image: string;
  type: ContainerType;
  status: ContainerStatus;
  description?: string;
  command?: string;
  ports?: Record<string, number>;
  mount?: string;
  mount_target?: string;
  network?: string;
  runtime_container_id?: string;
  exit_code?: number;
  created: string;
  removed?: string;
}

export type CheckpointHistoryRow = {
  role: 'user' | 'assistant' | 'error';
  content: string;
  ts: string;
};
