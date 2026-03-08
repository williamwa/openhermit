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
// web_fetch
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 200_000; // 200 KB — keeps responses inside context window

const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'Fully-qualified URL to fetch (http or https).',
  }),
  method: Type.Optional(
    Type.Union(
      [
        Type.Literal('GET'),
        Type.Literal('POST'),
        Type.Literal('PUT'),
        Type.Literal('PATCH'),
        Type.Literal('DELETE'),
        Type.Literal('HEAD'),
      ],
      { description: 'HTTP method. Defaults to GET.' },
    ),
  ),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: 'Additional request headers.',
    }),
  ),
  body: Type.Optional(
    Type.String({
      description: 'Request body (for POST/PUT/PATCH). Send as a string; set Content-Type in headers.',
    }),
  ),
  max_bytes: Type.Optional(
    Type.Number({
      description: `Maximum response body bytes to return. Defaults to ${MAX_RESPONSE_BYTES}.`,
    }),
  ),
});

type WebFetchArgs = Static<typeof WebFetchParams>;

const createWebFetchTool = (): AgentTool<typeof WebFetchParams> => ({
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Perform an HTTP request and return the response body as text. Useful for reading documentation, calling external APIs, or checking URLs. Responses are truncated at max_bytes to avoid flooding the context window.',
  parameters: WebFetchParams,
  execute: async (_toolCallId, args: WebFetchArgs) => {
    const url = new URL(args.url); // throws on invalid URL

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(`web_fetch only supports http/https URLs, got: ${url.protocol}`);
    }

    const method = args.method ?? 'GET';
    const limit = Math.min(args.max_bytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);

    const response = await fetch(args.url, {
      method,
      ...(args.headers ? { headers: args.headers } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
    });

    const rawBuffer = await response.arrayBuffer();
    const rawBytes = rawBuffer.byteLength;
    const truncated = rawBytes > limit;
    const bodyBytes = truncated ? rawBuffer.slice(0, limit) : rawBuffer;
    const body = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const details = {
      url: args.url,
      method,
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body,
      bodyBytes: rawBytes,
      ...(truncated ? { truncated: true, returnedBytes: limit } : {}),
    };

    const summary = truncated
      ? `HTTP ${response.status} ${response.statusText} — ${rawBytes} bytes (truncated to ${limit})\n\n${body}`
      : `HTTP ${response.status} ${response.statusText} — ${rawBytes} bytes\n\n${body}`;

    return {
      content: asTextContent(summary),
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
  createWebFetchTool(),
];
