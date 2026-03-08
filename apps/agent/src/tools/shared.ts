import { ValidationError } from '@openhermit/shared';

import { AgentSecurity, AgentWorkspace, type DockerContainerManager } from '../core/index.js';

const READONLY_BLOCKED_TOOLS = new Set([
  'write_file',
  'delete_file',
  'container_run',
  'container_start',
  'container_stop',
  'container_exec',
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
  workspace: AgentWorkspace;
  security: AgentSecurity;
  containerManager: DockerContainerManager;
  approvalCallback?: ApprovalCallback;
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
