import type { AgentTool } from '@mariozechner/pi-agent-core';

import { AgentSecurity } from '../core/index.js';
import {
  type ApprovalCallback,
  asTextContent,
  type ToolRequestedCallback,
  type ToolStartedCallback,
} from './shared.js';

export const withApproval = (
  tool: AgentTool<any>,
  security: AgentSecurity,
  approvalCallback: ApprovalCallback | undefined,
  onToolRequested?: ToolRequestedCallback,
  onToolStarted?: ToolStartedCallback,
): AgentTool<any> => {
  if (!approvalCallback) {
    if (!onToolRequested && !onToolStarted) {
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
        await onToolRequested?.(tool.name, toolCallId, args);
        await onToolStarted?.(tool.name, toolCallId, args);
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

      await onToolRequested?.(tool.name, toolCallId, args);

      if (needsApproval) {
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
      }

      await onToolStarted?.(tool.name, toolCallId, args);
      return tool.execute(toolCallId, args, signal, onUpdate);
    },
  };
};
