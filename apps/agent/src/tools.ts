import type { AgentTool } from '@mariozechner/pi-agent-core';

import { createContainerExecTool, createContainerRunTool, createContainerStartTool, createContainerStatusTool, createContainerStopTool, summarizeContainerEntry, summarizeContainerList } from './tools/container.js';
import { createMemoryAddTool, createMemoryDeleteTool, createMemoryGetTool, createMemoryRecallTool, createMemoryUpdateTool } from './tools/memory.js';
import { withApproval } from './tools/approval.js';
import type {
  ApprovalCallback,
  ApprovalDecision,
  ToolContext,
  ToolRequestedCallback,
  ToolStartedCallback,
} from './tools/shared.js';
import { createInstructionReadTool, createInstructionUpdateTool } from './tools/instruction.js';
import { createWebFetchTool } from './tools/web-fetch.js';
import { createWebSearchTool } from './tools/web-search.js';
import { createWorkspaceExecTool } from './tools/workspace-exec.js';

export type {
  ApprovalCallback,
  ApprovalDecision,
  ToolContext,
  ToolRequestedCallback,
  ToolStartedCallback,
} from './tools/shared.js';

export {
  summarizeContainerEntry,
  summarizeContainerList,
  withApproval,
};

export const createBuiltInTools = (
  context: ToolContext,
): AgentTool<any>[] => {
  const { security, approvalCallback, approvedCache, onToolRequested, onToolStarted } = context;

  const tools = [
    ...(context.memoryProvider
      ? [
          createMemoryGetTool(context),
          createMemoryRecallTool(context),
          createMemoryAddTool(context),
          createMemoryUpdateTool(context),
          createMemoryDeleteTool(context),
        ]
      : []),
    ...(context.instructionStore
      ? [
          createInstructionReadTool(context),
          createInstructionUpdateTool(context),
        ]
      : []),
    ...(context.webProvider
      ? [
          createWebSearchTool(context),
          createWebFetchTool(context),
        ]
      : []),
    createContainerRunTool(context),
    createContainerStatusTool(context),
    createContainerStartTool(context),
    createContainerStopTool(context),
    createContainerExecTool(context),
    ...(context.agentId ? [createWorkspaceExecTool(context)] : []),
    // working_memory_update is intentionally excluded from the main agent —
    // it is only available to the introspection agent to prevent overwrite conflicts.
  ];

  return tools.map((tool) =>
    withApproval(
      tool,
      security,
      approvalCallback,
      onToolRequested,
      onToolStarted,
      approvedCache,
    ),
  );
};
