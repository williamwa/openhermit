import type { AgentTool } from '@mariozechner/pi-agent-core';

import { createContainerExecTool, createContainerRunTool, createContainerStartTool, createContainerStatusTool, createContainerStopTool, summarizeContainerEntry, summarizeContainerList } from './tools/container.js';
import { createFileSearchTool } from './tools/file-search.js';
import { createDeleteFileTool, createListFilesTool, createReadFileTool, createWriteFileTool } from './tools/filesystem.js';
import { createMemoryGetTool, createMemoryRecallTool, createMemoryUpdateTool } from './tools/memory.js';
import { withApproval } from './tools/approval.js';
import type {
  ApprovalCallback,
  ApprovalDecision,
  ToolContext,
  ToolRequestedCallback,
  ToolStartedCallback,
} from './tools/shared.js';
import { createWebFetchTool } from './tools/web-fetch.js';

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
  const { security, approvalCallback, onToolRequested, onToolStarted } = context;

  const tools = [
    createReadFileTool(context),
    createWriteFileTool(context),
    createListFilesTool(context),
    createFileSearchTool(context),
    createDeleteFileTool(context),
    ...(context.memoryStore
      ? [
          createMemoryGetTool(context),
          createMemoryRecallTool(context),
          createMemoryUpdateTool(context),
        ]
      : []),
    createContainerRunTool(context),
    createContainerStatusTool(context),
    createWebFetchTool(),
    createContainerStartTool(context),
    createContainerStopTool(context),
    createContainerExecTool(context),
  ];

  return tools.map((tool) =>
    withApproval(
      tool,
      security,
      approvalCallback,
      onToolRequested,
      onToolStarted,
    ),
  );
};
