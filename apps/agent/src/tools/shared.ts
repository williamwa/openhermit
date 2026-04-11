import { ValidationError } from '@openhermit/shared';
import type { InstructionStore, MemoryProvider, StoreScope } from '@openhermit/store';

import { AgentSecurity, type DockerContainerManager, type WorkspaceContainerConfig } from '../core/index.js';

const READONLY_BLOCKED_TOOLS = new Set([
  'memory_add',
  'memory_update',
  'memory_delete',
  'container_run',
  'container_start',
  'container_stop',
  'container_exec',
  'exec',
  'instruction_update',
]);

export type ApprovalDecision = 'approved' | 'rejected' | 'timed_out' | 'cancelled';

export type ApprovalCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<ApprovalDecision>;

export type ToolStartedCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<void> | void;

export type ToolRequestedCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<void> | void;

export interface ToolContext {
  security: AgentSecurity;
  containerManager: DockerContainerManager;
  memoryProvider?: MemoryProvider;
  instructionStore?: InstructionStore;
  storeScope?: StoreScope;
  agentId?: string;
  workspaceContainerConfig?: WorkspaceContainerConfig;
  onExec?: () => void;
  approvalCallback?: ApprovalCallback;
  approvedCache?: Set<string>;
  onToolRequested?: ToolRequestedCallback;
  onToolStarted?: ToolStartedCallback;
}

export const asTextContent = (text: string) => [
  {
    type: 'text' as const,
    text,
  },
];

export const formatJson = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export const ensureAutonomyAllows = (
  security: AgentSecurity,
  toolName: string,
): void => {
  if (
    security.getAutonomyLevel() === 'readonly' &&
    READONLY_BLOCKED_TOOLS.has(toolName)
  ) {
    throw new ValidationError(`${toolName} is not allowed in readonly mode.`);
  }
};
