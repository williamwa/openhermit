import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ChannelOutbound } from '@openhermit/protocol';
import { ValidationError } from '@openhermit/shared';
import type { InstructionStore, MemoryProvider, MessageStore, ScheduleStore, SessionStore, StoreScope, UserStore } from '@openhermit/store';

import { AgentSecurity, type ExecBackendManager } from '../core/index.js';
import type { WebProvider } from '../web/index.js';

export interface Toolset {
  id: string;
  description: string;
  tools: AgentTool<any>[];
}

const READONLY_BLOCKED_TOOLS = new Set([
  'memory_add',
  'memory_update',
  'memory_delete',
  'working_memory_update',
  'exec',
  'instruction_update',
  'session_description_update',
  'session_send',
  'user_identity_link',
  'user_identity_unlink',
  'user_role_set',
  'user_merge',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
  'schedule_trigger',
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
  memoryProvider?: MemoryProvider;
  messageStore?: MessageStore | undefined;
  sessionStore?: SessionStore | undefined;
  sessionId?: string | undefined;
  currentUserId?: string | undefined;
  webProvider?: WebProvider | undefined;
  instructionStore?: InstructionStore;
  userStore?: UserStore;
  storeScope?: StoreScope;
  agentId?: string;
  execBackendManager?: ExecBackendManager;
  scheduleStore?: ScheduleStore;
  /** Channel outbound adapters keyed by channel name (e.g. 'telegram'). */
  channelOutbound?: Map<string, ChannelOutbound>;
  onExec?: () => void;
  onScheduleChange?: () => void;
  approvalCallback?: ApprovalCallback;
  approvedCache?: Set<string>;
  onToolRequested?: ToolRequestedCallback;
  onToolStarted?: ToolStartedCallback;
}

/** Maximum characters for a single tool result text block (~256 KB). */
const MAX_TOOL_RESULT_CHARS = 256_000;

export const asTextContent = (text: string) => {
  const truncated = text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS)
      + `\n\n[truncated: output was ${text.length.toLocaleString()} chars, kept first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}]`
    : text;
  return [
    {
      type: 'text' as const,
      text: truncated,
    },
  ];
};

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
