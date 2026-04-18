import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

import {
  type Toolset,
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
  formatJson,
} from './shared.js';

const WorkspaceExecParams = Type.Object({
  command: Type.String({
    description: 'Shell command to execute.',
  }),
  backend: Type.Optional(
    Type.String({
      description: 'Execution backend id. Omit to use the default backend.',
    }),
  ),
});

type WorkspaceExecArgs = Static<typeof WorkspaceExecParams>;

export const createWorkspaceExecTool = (
  context: ToolContext,
): AgentTool<typeof WorkspaceExecParams> => ({
  name: 'exec',
  label: 'Exec',
  description: buildExecDescription(context),
  parameters: WorkspaceExecParams,
  execute: async (_toolCallId, args: WorkspaceExecArgs) => {
    ensureAutonomyAllows(context.security, 'exec');

    // Prefer ExecBackendManager if available, fall back to legacy containerManager.
    if (context.execBackendManager) {
      const backend = context.execBackendManager.get(args.backend);
      await backend.ensure();
      context.onExec?.();
      const result = await backend.exec(args.command);

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
    }

    // Legacy path: direct containerManager usage.
    if (!context.agentId || !context.workspaceContainerConfig) {
      return {
        content: asTextContent(
          'exec is unavailable: no execution backend configured for this agent.',
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

function buildExecDescription(context: ToolContext): string {
  if (!context.execBackendManager) {
    return 'Execute a shell command. The workspace is at /workspace. Use this for all file operations (read, write, search, delete), build tools, language runtimes, tests, and any other shell task.';
  }
  const backends = context.execBackendManager.list();
  if (backends.length === 1) {
    return `Execute a shell command on ${backends[0]!.label}. Use this for all file operations, build tools, language runtimes, tests, and any other shell task.`;
  }
  const backendList = backends
    .map((b) => `- \`${b.id}\`: ${b.label}`)
    .join('\n');
  return `Execute a shell command. Use the \`backend\` parameter to choose an execution environment.\n\nAvailable backends:\n${backendList}\n\nUse this for all file operations, build tools, language runtimes, tests, and any other shell task.`;
}

// ── Toolset ────────────────────────────────────────────────────────

const EXEC_DESCRIPTION = `\
### Execution

Use \`exec\` to run any shell command. This is how you do everything: read files, write files, search, build, test, install packages, run scripts.

The execution environment is persistent. Installed packages and state survive between calls.`;

export const createExecToolset = (context: ToolContext): Toolset => ({
  id: 'exec',
  description: EXEC_DESCRIPTION,
  tools: [createWorkspaceExecTool(context)],
});
