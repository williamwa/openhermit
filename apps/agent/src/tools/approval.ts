import type { AgentTool } from '@mariozechner/pi-agent-core';

import { AgentSecurity } from '../core/index.js';
import type { AgentEventBus } from '../events.js';
import {
  type ApprovalCallback,
  asTextContent,
  type ToolCallCallback,
} from './shared.js';

export interface ToolHookContext {
  bus: AgentEventBus;
  agentId: string;
  sessionId: string;
}

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

/**
 * Run plugin hooks around a tool call. Returns either an early-result
 * (when a plugin vetoes) or the (possibly rewritten) args plus a
 * deferred `after` emitter the caller invokes once the tool finishes.
 */
const runHooks = async (
  hookCtx: ToolHookContext | undefined,
  toolName: string,
  toolCallId: string,
  rawArgs: unknown,
): Promise<{
  vetoed: { content: ReturnType<typeof asTextContent>; details: Record<string, unknown> } | null;
  args: unknown;
  emitAfter: (result: unknown, durationMs: number, ok: boolean, error?: string) => Promise<void>;
}> => {
  const fallback = {
    vetoed: null,
    args: rawArgs,
    emitAfter: async () => undefined,
  };
  if (!hookCtx) return fallback;

  const argsObj = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
  const decision = await hookCtx.bus.veto('tool.before@v1', {
    agentId: hookCtx.agentId,
    sessionId: hookCtx.sessionId,
    toolName,
    toolCallId,
    args: argsObj,
  });

  if (!decision.allow) {
    return {
      vetoed: {
        content: asTextContent(`Tool call "${toolName}" was blocked by a plugin: ${decision.reason}`),
        details: { rejected: true, toolName, vetoedBy: 'plugin', reason: decision.reason },
      },
      args: rawArgs,
      emitAfter: async () => undefined,
    };
  }

  const nextArgs = decision.payload?.args ?? rawArgs;
  const emitAfter = async (result: unknown, durationMs: number, ok: boolean, error?: string) => {
    await hookCtx.bus.emit('tool.after@v1', {
      agentId: hookCtx.agentId,
      sessionId: hookCtx.sessionId,
      toolName,
      toolCallId,
      args: (nextArgs && typeof nextArgs === 'object' ? nextArgs as Record<string, unknown> : {}),
      result,
      durationMs,
      ok,
      ...(error ? { error } : {}),
    });
  };
  return { vetoed: null, args: nextArgs, emitAfter };
};

const callWithHooks = async (
  tool: AgentTool<any>,
  toolCallId: string,
  args: unknown,
  signal: AbortSignal | undefined,
  onUpdate: Parameters<AgentTool<any>['execute']>[3] | undefined,
  hookCtx: ToolHookContext | undefined,
): Promise<Awaited<ReturnType<AgentTool<any>['execute']>>> => {
  const hooks = await runHooks(hookCtx, tool.name, toolCallId, args);
  if (hooks.vetoed) {
    return hooks.vetoed as Awaited<ReturnType<AgentTool<any>['execute']>>;
  }

  const startedAt = Date.now();
  try {
    const result = await tool.execute(toolCallId, hooks.args, signal, onUpdate);
    await hooks.emitAfter(result, Date.now() - startedAt, true);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await hooks.emitAfter(undefined, Date.now() - startedAt, false, message);
    throw err;
  }
};

export const withApproval = (
  tool: AgentTool<any>,
  security: AgentSecurity,
  approvalCallback: ApprovalCallback | undefined,
  onToolCall?: ToolCallCallback,
  approvedCache?: Set<string>,
  hookCtx?: ToolHookContext,
): AgentTool<any> => {
  if (!approvalCallback) {
    if (!onToolCall && !hookCtx) {
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
        if (onToolCall) await onToolCall(tool.name, toolCallId, args);
        return callWithHooks(tool, toolCallId, args, signal, onUpdate, hookCtx);
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
      return callWithHooks(tool, toolCallId, args, signal, onUpdate, hookCtx);
    },
  };
};
