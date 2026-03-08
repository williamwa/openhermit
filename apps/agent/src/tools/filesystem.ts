import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';

import { type ToolContext, asTextContent, ensureAutonomyAllows, formatJson } from './shared.js';

const ReadFileParams = Type.Object({
  path: Type.String({ description: 'Workspace-relative file path.' }),
});

type ReadFileArgs = Static<typeof ReadFileParams>;

export const createReadFileTool = ({
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

export const createWriteFileTool = ({
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

export const createListFilesTool = ({
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

export const createDeleteFileTool = ({
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
