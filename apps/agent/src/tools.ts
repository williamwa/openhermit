import type { AgentTool } from '@mariozechner/pi-agent-core';

import { createMemoryToolset } from './tools/memory.js';
import { withApproval } from './tools/approval.js';
import type {
  ApprovalCallback,
  ApprovalDecision,
  Toolset,
  ToolContext,
  ToolRequestedCallback,
  ToolStartedCallback,
} from './tools/shared.js';
import { createInstructionToolset } from './tools/instruction.js';
import { createWebToolset } from './tools/web.js';
import { createSessionToolset } from './tools/session.js';
import { createUserToolset } from './tools/user.js';
import { createExecToolset } from './tools/workspace-exec.js';

export type {
  ApprovalCallback,
  ApprovalDecision,
  Toolset,
  ToolContext,
  ToolRequestedCallback,
  ToolStartedCallback,
} from './tools/shared.js';

export {
  withApproval,
};

export const toolsFromToolsets = (toolsets: Toolset[]): AgentTool<any>[] =>
  toolsets.flatMap((ts) => ts.tools);

export const createBuiltInTools = (context: ToolContext): AgentTool<any>[] =>
  toolsFromToolsets(createBuiltInToolsets(context));

export const createBuiltInToolsets = (
  context: ToolContext,
): Toolset[] => {
  const { security, approvalCallback, approvedCache, onToolRequested, onToolStarted } = context;

  const toolsets: Toolset[] = [];

  if (context.memoryProvider) {
    toolsets.push(createMemoryToolset(context));
  }
  if (context.instructionStore) {
    toolsets.push(createInstructionToolset(context));
  }
  if (context.webProvider) {
    toolsets.push(createWebToolset(context));
  }
  if (context.agentId) {
    toolsets.push(createExecToolset(context));
  }
  if (context.userStore) {
    toolsets.push(createUserToolset(context));
  }
  if (context.sessionStore) {
    toolsets.push(createSessionToolset(context));
  }
  // working_memory_update is intentionally excluded from the main agent —
  // it is only available to the introspection agent to prevent overwrite conflicts.

  // Apply withApproval to all tools in all toolsets
  return toolsets.map((ts) => ({
    ...ts,
    tools: ts.tools.map((tool) =>
      withApproval(
        tool,
        security,
        approvalCallback,
        onToolRequested,
        onToolStarted,
        approvedCache,
      ),
    ),
  }));
};
