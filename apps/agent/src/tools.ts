import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ValidationError } from '@cloudmind/shared';

import {
  type DockerContainerManager,
  type ContainerListEntry,
  type ContainerRegistryEntry,
} from './core/index.js';
import { AgentSecurity, AgentWorkspace } from './core/index.js';

const READONLY_BLOCKED_TOOLS = new Set([
  'write_file',
  'delete_file',
  'container_run',
]);

/**
 * Called before a tool executes when approval is required.
 * Returns an explicit decision so timeout and user denial are distinguishable.
 */
export type ApprovalDecision = 'approved' | 'rejected' | 'timed_out' | 'cancelled';

export type ApprovalCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<ApprovalDecision>;

export type ToolStartedCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<void> | void;

export type ToolRequestedCallback = (
  toolName: string,
  toolCallId: string,
  args: unknown,
) => Promise<void> | void;

interface ToolContext {
  workspace: AgentWorkspace;
  security: AgentSecurity;
  containerManager: DockerContainerManager;
  /** When present, tools in security.require_approval_for pause for confirmation. */
  approvalCallback?: ApprovalCallback;
  /** Called as soon as the agent decides to invoke the tool. */
  onToolRequested?: ToolRequestedCallback;
  /** Called immediately before the underlying tool.execute() runs. */
  onToolStarted?: ToolStartedCallback;
}

const asTextContent = (text: string) => [
  {
    type: 'text' as const,
    text,
  },
];

const formatJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const ensureAutonomyAllows = (
  security: AgentSecurity,
  toolName: string,
): void => {
  if (
    security.getAutonomyLevel() === 'readonly' &&
    READONLY_BLOCKED_TOOLS.has(toolName)
  ) {
    throw new ValidationError(`${toolName} is not allowed in readonly mode.`);
  }
};

const ReadFileParams = Type.Object({
  path: Type.String({ description: 'Workspace-relative file path.' }),
});

type ReadFileArgs = Static<typeof ReadFileParams>;

const createReadFileTool = ({
  workspace,
  security,
}: ToolContext): AgentTool<typeof ReadFileParams> => ({
  name: 'read_file',
  label: 'Read File',
  description: 'Read a UTF-8 text file inside the agent workspace.',
  parameters: ReadFileParams,
  execute: async (_toolCallId, args: ReadFileArgs) => {
    await security.checkPath(args.path, {
      mustExist: true,
      kind: 'file',
    });

    const content = await workspace.readFile(args.path);

    return {
      content: asTextContent(content),
      details: {
        path: args.path,
        content,
      },
    };
  },
});

const WriteFileParams = Type.Object({
  path: Type.String({ description: 'Workspace-relative file path.' }),
  content: Type.String({ description: 'Full file content to write.' }),
});

type WriteFileArgs = Static<typeof WriteFileParams>;

const createWriteFileTool = ({
  workspace,
  security,
}: ToolContext): AgentTool<typeof WriteFileParams> => ({
  name: 'write_file',
  label: 'Write File',
  description: 'Write a UTF-8 text file inside the agent workspace.',
  parameters: WriteFileParams,
  execute: async (_toolCallId, args: WriteFileArgs) => {
    ensureAutonomyAllows(security, 'write_file');
    await security.checkPath(args.path);
    await workspace.writeFile(args.path, args.content);

    return {
      content: asTextContent(`Wrote ${args.path}`),
      details: {
        path: args.path,
        bytes: Buffer.byteLength(args.content, 'utf8'),
      },
    };
  },
});

const ListFilesParams = Type.Object({
  path: Type.Optional(
    Type.String({
      description: 'Workspace-relative directory path. Defaults to ".".',
    }),
  ),
});

type ListFilesArgs = Static<typeof ListFilesParams>;

const createListFilesTool = ({
  workspace,
  security,
}: ToolContext): AgentTool<typeof ListFilesParams> => ({
  name: 'list_files',
  label: 'List Files',
  description: 'List entries in a workspace directory.',
  parameters: ListFilesParams,
  execute: async (_toolCallId, args: ListFilesArgs) => {
    const directory = args.path ?? '.';
    await security.checkPath(directory, {
      mustExist: true,
      kind: 'directory',
    });

    const entries = await workspace.listFiles(directory);

    return {
      content: asTextContent(formatJson(entries)),
      details: {
        path: directory,
        entries,
      },
    };
  },
});

const DeleteFileParams = Type.Object({
  path: Type.String({ description: 'Workspace-relative file path.' }),
});

type DeleteFileArgs = Static<typeof DeleteFileParams>;

const createDeleteFileTool = ({
  workspace,
  security,
}: ToolContext): AgentTool<typeof DeleteFileParams> => ({
  name: 'delete_file',
  label: 'Delete File',
  description: 'Delete a single file inside the workspace.',
  parameters: DeleteFileParams,
  execute: async (_toolCallId, args: DeleteFileArgs) => {
    ensureAutonomyAllows(security, 'delete_file');
    await security.checkPath(args.path, {
      mustExist: true,
      kind: 'file',
    });
    await workspace.deleteFile(args.path);

    return {
      content: asTextContent(`Deleted ${args.path}`),
      details: {
        path: args.path,
      },
    };
  },
});

const ContainerRunParams = Type.Object({
  image: Type.String({ description: 'Docker image name.' }),
  command: Type.String({ description: 'Shell command to execute.' }),
  description: Type.Optional(
    Type.String({
      description: 'Short note describing why this ephemeral container exists.',
    }),
  ),
  mount: Type.Optional(
    Type.String({
      description:
        'Optional workspace path under containers/{name}/data. If omitted, a fresh empty mount is created. Files under files/ are not mounted automatically.',
    }),
  ),
  env_secrets: Type.Optional(
    Type.Array(
      Type.String({
        description: 'Secret names to inject as environment variables.',
      }),
    ),
  ),
  workdir: Type.Optional(
    Type.String({
      description: 'Working directory inside the container.',
    }),
  ),
});

type ContainerRunArgs = Static<typeof ContainerRunParams>;

const EmptyParams = Type.Object({});

const createContainerRunTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerRunParams> => ({
  name: 'container_run',
  label: 'Run Container',
  description:
    'Run a one-off command in an ephemeral Docker container. The container only sees the selected mount under containers/{name}/data; if you need to run a script, write or copy it there first and pass that mount.',
  parameters: ContainerRunParams,
  execute: async (_toolCallId, args: ContainerRunArgs) => {
    ensureAutonomyAllows(security, 'container_run');

    const env =
      args.env_secrets && args.env_secrets.length > 0
        ? security.resolveSecrets(args.env_secrets)
        : undefined;

    const result = await containerManager.runEphemeral({
      image: args.image,
      command: args.command,
      ...(args.description ? { description: args.description } : {}),
      ...(args.mount ? { mount: args.mount } : {}),
      ...(args.workdir ? { workdir: args.workdir } : {}),
      ...(env ? { env } : {}),
    });

    const details = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined
        ? { parsedOutput: result.parsedOutput }
        : {}),
      container: result.container,
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});

const createContainerStatusTool = ({
  containerManager,
}: ToolContext): AgentTool<typeof EmptyParams> => ({
  name: 'container_status',
  label: 'Container Status',
  description: 'List known containers and their current status.',
  parameters: EmptyParams,
  execute: async () => {
    const containers = await containerManager.listAll();

    return {
      content: asTextContent(formatJson(containers)),
      details: {
        containers,
      },
    };
  },
});

export const summarizeContainerList = (
  containers: ContainerListEntry[],
): string => formatJson(containers);

export const summarizeContainerEntry = (
  container: ContainerRegistryEntry,
): string => formatJson(container);

/**
 * Wraps a tool so that calls to tools listed in security.require_approval_for
 * will pause and invoke the approval callback before executing.
 * In `full` autonomy mode or when no callback is provided, tools always proceed.
 */
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

export const createBuiltInTools = (
  context: ToolContext,
): AgentTool<any>[] => {
  const { security, approvalCallback, onToolStarted } = context;
  const { onToolRequested } = context;

  const tools = [
    createReadFileTool(context),
    createWriteFileTool(context),
    createListFilesTool(context),
    createDeleteFileTool(context),
    createContainerRunTool(context),
    createContainerStatusTool(context),
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
