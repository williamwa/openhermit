import type { Agent, StreamFn } from '@mariozechner/pi-agent-core';
import type { SessionStatus } from '@openhermit/protocol';

import type { AgentConfig } from '../core/index.js';
import type { LangfuseClientLike } from '../langfuse.js';
import type { SessionDescriptor } from '../runtime.js';
import type { ApprovalGate } from './approval-gate.js';

export interface RunnerSession extends SessionDescriptor {
  agent: Agent;
  queue: Promise<void>;
  sideEffects: Promise<void>;
  backgroundTasks: Promise<void>;
  checkpointInProgress: boolean;
  idleSummaryTimer: ReturnType<typeof setTimeout> | undefined;
  latestAssistantText: string | undefined;
  lastUserMessageText?: string;
  approvalGate: ApprovalGate;
  status: SessionStatus;
  messageCount: number;
  completedTurnCount: number;
  lastSummarizedHistoryCount: number;
  lastSummarizedTurnCount: number;
  lastSummarizedAt?: string;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
}

export interface AgentRunnerOptions {
  workspace: import('../core/index.js').AgentWorkspace;
  security: import('../core/index.js').AgentSecurity;
  containerManager?: import('../core/index.js').DockerContainerManager;
  streamFn?: StreamFn;
  langfuse?: LangfuseClientLike;
  sessionDescriptionGenerator?: (
    input: {
      sessionId: string;
      userText: string;
      assistantText?: string;
      config: AgentConfig;
    },
  ) => Promise<string | undefined>;
  checkpointSummaryGenerator?: (
    input: {
      sessionId: string;
      reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
      history: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>;
      config: AgentConfig;
    },
  ) => Promise<string | undefined>;
  sessionWorkingMemoryGenerator?: (
    input: {
      sessionId: string;
      previousWorkingMemory: string | undefined;
      checkpointSummary: string;
      reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
      config: AgentConfig;
    },
  ) => Promise<string | undefined>;
  contextCompactionMaxTokens?: number;
  contextCompactionRecentMessageCount?: number;
  contextCompactionSummaryMaxChars?: number;
  idleSummaryTimeoutMs?: number;
  checkpointTurnInterval?: number;
}
