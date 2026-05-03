import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

import { AGENT_CONTAINER_HOME } from '../core/types.js';
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

    if (!context.execBackendManager) {
      return {
        content: asTextContent(
          'exec is unavailable: no execution backend configured for this agent.',
        ),
        details: {},
      };
    }

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
  },
});

function buildExecDescription(context: ToolContext): string {
  if (!context.execBackendManager) {
    return `Execute a shell command. The workspace is at ${AGENT_CONTAINER_HOME}. Use this for all file operations (read, write, search, delete), build tools, language runtimes, tests, and any other shell task.`;
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

The execution environment is persistent. Installed packages and state survive between calls.

**Important**: stdin is closed — interactive commands that prompt for user input will fail. Use non-interactive alternatives instead (e.g. \`--yes\`, \`--non-interactive\`, \`--with-token\`, environment variables). For authentication, use tokens from agent secrets rather than interactive login flows.

**Output is not streamed**: \`exec\` returns stdout/stderr only after the process exits. You will not see partial output during the run, so prefer many short calls over one long-running call.

**Long-running / daemon / tunnel commands** (ssh tunnels, dev servers, \`tail -f\`, watchers, anything that does not exit on its own): do NOT run them in the foreground — even with \`timeout N\`, you will get zero feedback for N seconds and may hit the wall-clock timeout. Instead:
1. Launch in the background, redirecting output: \`nohup <cmd> > /tmp/x.log 2>&1 &\` — this returns immediately with the PID.
2. In a second \`exec\` call, poll the log: \`sleep 2 && tail -n 50 /tmp/x.log\` (or grep it for the string you need).
3. When done, kill it explicitly: \`kill <pid>\` (capture the PID from \`$!\` after launch if needed).

**Avoid the \`timeout N <cmd> | grep …\` pattern** for capturing output from a process that would otherwise run forever. Two problems: (a) you get no feedback for N seconds; (b) \`grep\` block-buffers when its stdout is a pipe, so even matched lines may not flush before \`grep\` exits. Prefer redirect-then-grep: \`<cmd> > /tmp/x.log 2>&1; grep -E '…' /tmp/x.log\`, or add \`grep --line-buffered\` if you really must pipe.`;

export const createExecToolset = (context: ToolContext): Toolset => ({
  id: 'exec',
  description: EXEC_DESCRIPTION,
  tools: [createWorkspaceExecTool(context)],
});
