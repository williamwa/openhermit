import type { AgentTool } from '@mariozechner/pi-agent-core';

import { createMemoryAddTool, createMemoryDeleteTool, createMemoryGetTool, createMemoryRecallTool, createMemoryUpdateTool } from '../tools/memory.js';
import { createWorkingMemoryUpdateTool } from '../tools/working-memory.js';
import type { ToolContext } from '../tools/shared.js';

/**
 * Creates the tool set available to the introspection agent.
 * Only memory tools and working memory — no exec, container, web, or instruction tools.
 * No approval wrapping — introspection is an internal process.
 */
export const createIntrospectionTools = (
  context: ToolContext,
): AgentTool<any>[] => {
  const tools: AgentTool<any>[] = [];

  if (context.memoryProvider) {
    tools.push(
      createMemoryGetTool(context),
      createMemoryRecallTool(context),
      createMemoryAddTool(context),
      createMemoryUpdateTool(context),
      createMemoryDeleteTool(context),
    );
  }

  if (context.messageStore && context.storeScope && context.sessionId) {
    tools.push(createWorkingMemoryUpdateTool(context));
  }

  return tools;
};
