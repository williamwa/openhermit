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
  'container_start',
  'container_stop',
  'container_exec',
]);

interface ToolContext {
  workspace: AgentWorkspace;
  security: AgentSecurity;
  containerManager: DockerContainerManager;
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

// ---------------------------------------------------------------------------
// container_start
// ---------------------------------------------------------------------------

const ContainerStartParams = Type.Object({
  name: Type.String({
    description:
      'Unique name for the service container. Used to reference it in stop/exec calls.',
  }),
  image: Type.String({ description: 'Docker image name.' }),
  description: Type.Optional(
    Type.String({
      description: 'Short note describing the purpose of this service.',
    }),
  ),
  mount: Type.Optional(
    Type.String({
      description:
        'Workspace path under containers/{name}/data to mount at /data inside the container. Defaults to containers/{name}/data.',
    }),
  ),
  ports: Type.Optional(
    Type.Record(
      Type.String({ description: 'Container port (e.g. "5432").' }),
      Type.Number({ description: 'Host port to bind (e.g. 10001).' }),
      {
        description:
          'Port mappings: { "<containerPort>": <hostPort> }. Warn the user to run "tailscale funnel <hostPort>" themselves if external access is needed.',
      },
    ),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Plain environment variables to pass to the container.',
    }),
  ),
  env_secrets: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Secret names whose values are resolved at launch and injected as env vars. Values are never returned to the agent.',
    }),
  ),
  network: Type.Optional(
    Type.String({
      description:
        'Docker network name. Containers on the same network can reach each other by container name.',
    }),
  ),
});

type ContainerStartArgs = Static<typeof ContainerStartParams>;

const createContainerStartTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerStartParams> => ({
  name: 'container_start',
  label: 'Start Service Container',
  description:
    'Start a long-running service container (e.g. Postgres, Redis). The container is registered and persists across agent restarts until explicitly stopped. Port bindings expose the service on the host; inform the user if external access requires additional host configuration.',
  parameters: ContainerStartParams,
  execute: async (_toolCallId, args: ContainerStartArgs) => {
    ensureAutonomyAllows(security, 'container_start');

    const secretEnv =
      args.env_secrets && args.env_secrets.length > 0
        ? security.resolveSecrets(args.env_secrets)
        : {};

    const env =
      Object.keys(secretEnv).length > 0 || (args.env && Object.keys(args.env).length > 0)
        ? { ...(args.env ?? {}), ...secretEnv }
        : undefined;

    const entry = await containerManager.startService({
      name: args.name,
      image: args.image,
      ...(args.description ? { description: args.description } : {}),
      ...(args.mount ? { mount: args.mount } : {}),
      ...(args.ports ? { ports: args.ports } : {}),
      ...(env ? { env } : {}),
      ...(args.network ? { network: args.network } : {}),
    });

    const portHints =
      entry.ports && Object.keys(entry.ports).length > 0
        ? `\nBound ports: ${Object.entries(entry.ports)
            .map(([containerPort, hostPort]) => `${containerPort} → host:${hostPort}`)
            .join(', ')}. Run "tailscale funnel <hostPort>" on the host if external access is needed.`
        : '';

    return {
      content: asTextContent(`Service "${entry.name}" started.${portHints}`),
      details: entry,
    };
  },
});

// ---------------------------------------------------------------------------
// container_stop
// ---------------------------------------------------------------------------

const ContainerStopParams = Type.Object({
  name: Type.String({ description: 'Name of the service container to stop and remove.' }),
});

type ContainerStopArgs = Static<typeof ContainerStopParams>;

const createContainerStopTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerStopParams> => ({
  name: 'container_stop',
  label: 'Stop Service Container',
  description: 'Stop and remove a running service container. The registry entry is preserved with status "removed".',
  parameters: ContainerStopParams,
  execute: async (_toolCallId, args: ContainerStopArgs) => {
    ensureAutonomyAllows(security, 'container_stop');

    const entry = await containerManager.stopService(args.name);

    return {
      content: asTextContent(`Service "${entry.name}" stopped.`),
      details: entry,
    };
  },
});

// ---------------------------------------------------------------------------
// container_exec
// ---------------------------------------------------------------------------

const ContainerExecParams = Type.Object({
  name: Type.String({ description: 'Name of the running service container.' }),
  command: Type.String({ description: 'Shell command to execute inside the container.' }),
});

type ContainerExecArgs = Static<typeof ContainerExecParams>;

const createContainerExecTool = ({
  security,
  containerManager,
}: ToolContext): AgentTool<typeof ContainerExecParams> => ({
  name: 'container_exec',
  label: 'Exec in Service Container',
  description:
    'Execute a shell command inside a running service container and return stdout/stderr. Use this to inspect state, run migrations, or interact with a service.',
  parameters: ContainerExecParams,
  execute: async (_toolCallId, args: ContainerExecArgs) => {
    ensureAutonomyAllows(security, 'container_exec');

    const result = await containerManager.execInService(args.name, args.command);

    const details = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      ...(result.parsedOutput !== undefined ? { parsedOutput: result.parsedOutput } : {}),
    };

    return {
      content: asTextContent(formatJson(details)),
      details,
    };
  },
});

export const summarizeContainerList = (
  containers: ContainerListEntry[],
): string => formatJson(containers);

export const summarizeContainerEntry = (
  container: ContainerRegistryEntry,
): string => formatJson(container);

export const createBuiltInTools = (
  context: ToolContext,
): AgentTool<any>[] => [
  createReadFileTool(context),
  createWriteFileTool(context),
  createListFilesTool(context),
  createDeleteFileTool(context),
  createContainerRunTool(context),
  createContainerStatusTool(context),
  createContainerStartTool(context),
  createContainerStopTool(context),
  createContainerExecTool(context),
];
