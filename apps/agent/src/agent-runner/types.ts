import type { Agent, StreamFn } from '@mariozechner/pi-agent-core';
import type { SessionStatus } from '@openhermit/protocol';

import type { AgentConfig } from '../core/index.js';
import type { SessionDescriptor } from '../runtime.js';
import type { ApprovalGate } from './approval-gate.js';

export interface RunnerSession extends SessionDescriptor {
  agent: Agent;
  queue: Promise<void>;
  sideEffects: Promise<void>;
  backgroundTasks: Promise<void>;
  sessionLogRelativePath: string;
  episodicRelativePath: string;
  latestAssistantText: string | undefined;
  lastUserMessageText?: string;
  approvalGate: ApprovalGate;
  status: SessionStatus;
  messageCount: number;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
}

export interface AgentRunnerOptions {
  workspace: import('../core/index.js').AgentWorkspace;
  security: import('../core/index.js').AgentSecurity;
  containerManager?: import('../core/index.js').DockerContainerManager;
  streamFn?: StreamFn;
  sessionDescriptionGenerator?: (
    input: {
      userText: string;
      assistantText?: string;
      config: AgentConfig;
    },
  ) => Promise<string | undefined>;
}
