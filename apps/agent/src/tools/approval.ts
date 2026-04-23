import type { AgentTool } from '@mariozechner/pi-agent-core';

import { AgentSecurity } from '../core/index.js';
import {
  type ApprovalCallback,
  asTextContent,
  type ToolCallCallback,
} from './shared.js';

const approvalCacheKey = (toolName: string, args: unknown): string | undefined => {
  if (
    toolName === 'container_start' &&
    args !== null &&
    typeof args === 'object' &&
    'name' in args &&
    typeof (args as Record<string, unknown>).name === 'string'
  ) {
    return `${toolName}::${(args as Record<string, unknown>).name}`;
  }

  if (
    toolName === 'exec' &&
    args !== null &&
    typeof args === 'object' &&
    'command' in args &&
    typeof (args as Record<string, unknown>).command === 'string'
  ) {
    return `${toolName}::${(args as Record<string, unknown>).command}`;
  }

  return undefined;
};

export const withApproval = (
  tool: AgentTool<any>,
  security: AgentSecurity,
  approvalCallback: ApprovalCallback | undefined,
  onToolCall?: ToolCallCallback,
  approvedCache?: Set<string>,
): AgentTool<any> => {
  if (!approvalCallback) {
    if (!onToolCall) {
      return tool;
    }

    return {
      ...tool,
      execute: async (
        toolCallId: string,
        args: unknown,
        signal?: AbortSignal,
        onUpdate?: Parameters<AgentTool<any>['execute']>[3],
      ) => {
        await onToolCall(tool.name, toolCallId, args);
        return tool.execute(toolCallId, args, signal, onUpdate);
      },
    };
  }

  return {
    ...tool,
    execute: async (
      toolCallId: string,
      args: unknown,
      signal?: AbortSignal,
      onUpdate?: Parameters<AgentTool<any>['execute']>[3],
    ) => {
      const needsApproval =
        security.getAutonomyLevel() !== 'full' &&
        security.requiresApproval(tool.name);

      if (needsApproval) {
        const cacheKey = approvalCacheKey(tool.name, args);

        if (cacheKey && approvedCache?.has(cacheKey)) {
          // Already approved in this session — skip prompt.
        } else {
          const decision = await approvalCallback(tool.name, toolCallId, args);

          if (decision !== 'approved') {
            const text =
              decision === 'timed_out'
                ? `Tool call "${tool.name}" timed out waiting for user approval.`
                : decision === 'cancelled'
                  ? `Tool call "${tool.name}" was cancelled before approval was received.`
                  : `Tool call "${tool.name}" was rejected by the user.`;

            return {
              content: asTextContent(text),
              details: {
                rejected: true,
                toolName: tool.name,
                approvalStatus: decision,
              },
            };
          }

          if (cacheKey && approvedCache) {
            approvedCache.add(cacheKey);
          }
        }
      }

      await onToolCall?.(tool.name, toolCallId, args);
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
};
