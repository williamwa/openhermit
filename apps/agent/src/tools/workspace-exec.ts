import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

import {
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
  formatJson,
} from './shared.js';

const WorkspaceExecParams = Type.Object({
  command: Type.String({
    description: 'Shell command to execute inside the workspace container.',
  }),
});

type WorkspaceExecArgs = Static<typeof WorkspaceExecParams>;

export const createWorkspaceExecTool = (
  context: ToolContext,
): AgentTool<typeof WorkspaceExecParams> => ({
  name: 'exec',
  label: 'Exec',
  description:
    'Execute a shell command. The workspace is at /workspace. Use this for all file operations (read, write, search, delete), build tools, language runtimes, tests, and any other shell task.',
  parameters: WorkspaceExecParams,
  execute: async (_toolCallId, args: WorkspaceExecArgs) => {
    ensureAutonomyAllows(context.security, 'exec');

    if (!context.agentId || !context.workspaceContainerConfig) {
      return {
        content: asTextContent(
          'exec is unavailable: no workspace container configured for this agent.',
        ),
        details: {},
      };
    }

    await context.containerManager.ensureWorkspaceContainer(
      context.agentId,
      context.workspaceContainerConfig,
    );

    context.onExec?.();

    const result = await context.containerManager.execInWorkspace(
      context.agentId,
      args.command,
    );

    const details = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined
        ? { parsedOutput: result.parsedOutput }
        : {}),
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});
