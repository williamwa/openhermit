import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ValidationError } from '@openhermit/shared';

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

const escapeRegExp = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

const globToRegExp = (glob: string): RegExp => {
  let pattern = '^';

  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];

    if (character === undefined) {
      continue;
    }

    if (character === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?';
          index += 2;
        } else {
          pattern += '.*';
          index += 1;
        }
      } else {
        pattern += '[^/]*';
      }
      continue;
    }

    if (character === '?') {
      pattern += '[^/]';
      continue;
    }

    pattern += escapeRegExp(character);
  }

  pattern += '$';
  return new RegExp(pattern);
};

const SEARCH_MAX_MATCHES = 100;
const SEARCH_MAX_FILE_BYTES = 1_000_000;
const RIPGREP_BINARY = process.env.OPENHERMIT_RIPGREP_BIN ?? 'rg';
let ripgrepAvailablePromise: Promise<boolean> | undefined;

interface FileSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface SearchCandidate {
  absolutePath: string;
  relativePath: string;
}

interface FileSearchResultDetails {
  pattern: string;
  path: string;
  glob?: string;
  scannedFiles: number;
  matchedFiles: number;
  totalMatches: number;
  returnedMatches: number;
  truncated: boolean;
  skippedLargeFiles: string[];
  matches: FileSearchMatch[];
}

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

const FileSearchParams = Type.Object({
  pattern: Type.String({
    description: 'Literal text pattern to search for inside workspace files.',
  }),
  path: Type.Optional(
    Type.String({
      description:
        'Workspace-relative file or directory to search. Defaults to ".".',
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description:
        'Optional glob filter applied to workspace-relative file paths, e.g. "files/**/*.md".',
    }),
  ),
});

type FileSearchArgs = Static<typeof FileSearchParams>;

const formatSearchSummary = (details: FileSearchResultDetails): string => {
  if (details.totalMatches === 0) {
    return `No matches found for "${details.pattern}" in ${details.path}.`;
  }

  const lines = [
    `Found ${details.totalMatches} matches in ${details.matchedFiles} file(s) while scanning ${details.scannedFiles} file(s).`,
  ];

  for (const match of details.matches) {
    lines.push(`${match.path}:${match.line}:${match.column} ${match.text}`);
  }

  if (details.truncated) {
    lines.push(`Results truncated to the first ${details.returnedMatches} matches.`);
  }

  if (details.skippedLargeFiles.length > 0) {
    lines.push(
      `Skipped ${details.skippedLargeFiles.length} large file(s): ${details.skippedLargeFiles.join(', ')}`,
    );
  }

  return lines.join('\n');
};

const runSubprocess = (
  binary: string,
  args: string[],
  cwd?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });

const isRipgrepAvailable = async (): Promise<boolean> => {
  if (!ripgrepAvailablePromise) {
    ripgrepAvailablePromise = runSubprocess(RIPGREP_BINARY, ['--version'])
      .then((result) => result.exitCode === 0)
      .catch(() => false);
  }

  return ripgrepAvailablePromise;
};

const collectSearchCandidates = async (
  workspace: AgentWorkspace,
  resolvedTarget: string,
  globMatcher?: RegExp,
): Promise<SearchCandidate[]> => {
  const candidateFiles: string[] = [];

  const walk = async (absolutePath: string): Promise<void> => {
    const stats = await fs.lstat(absolutePath);

    if (stats.isSymbolicLink()) {
      return;
    }

    if (stats.isFile()) {
      candidateFiles.push(absolutePath);
      return;
    }

    if (!stats.isDirectory()) {
      return;
    }

    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      await walk(path.join(absolutePath, entry.name));
    }
  };

  const targetStats = await fs.stat(resolvedTarget);
  if (targetStats.isFile()) {
    candidateFiles.push(resolvedTarget);
  } else {
    await walk(resolvedTarget);
  }

  return candidateFiles
    .map((absolutePath) => ({
      absolutePath,
      relativePath: workspace.toRelativePath(absolutePath),
    }))
    .filter(
      (candidate) => !globMatcher || globMatcher.test(candidate.relativePath),
    );
};

const searchCandidatesWithNode = async (
  candidates: SearchCandidate[],
  pattern: string,
): Promise<{
  matches: FileSearchMatch[];
  matchedFiles: Set<string>;
  totalMatches: number;
}> => {
  const matches: FileSearchMatch[] = [];
  const matchedFiles = new Set<string>();
  let totalMatches = 0;

  for (const candidate of candidates) {
    const content = await fs.readFile(candidate.absolutePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex] ?? '';
      let searchFrom = 0;

      while (searchFrom <= line.length) {
        const matchIndex = line.indexOf(pattern, searchFrom);

        if (matchIndex === -1) {
          break;
        }

        totalMatches += 1;
        matchedFiles.add(candidate.relativePath);

        if (matches.length < SEARCH_MAX_MATCHES) {
          matches.push({
            path: candidate.relativePath,
            line: lineIndex + 1,
            column: matchIndex + 1,
            text: line,
          });
        }

        searchFrom = matchIndex + Math.max(pattern.length, 1);
      }
    }
  }

  return {
    matches,
    matchedFiles,
    totalMatches,
  };
};

const searchCandidatesWithRipgrep = async (
  workspace: AgentWorkspace,
  candidates: SearchCandidate[],
  pattern: string,
): Promise<{
  matches: FileSearchMatch[];
  matchedFiles: Set<string>;
  totalMatches: number;
}> => {
  if (candidates.length === 0) {
    return {
      matches: [],
      matchedFiles: new Set<string>(),
      totalMatches: 0,
    };
  }

  const result = await runSubprocess(
    RIPGREP_BINARY,
    [
      '--json',
      '--fixed-strings',
      '--with-filename',
      '--line-number',
      '--column',
      '--no-config',
      pattern,
      ...candidates.map((candidate) => candidate.relativePath),
    ],
    workspace.root,
  );

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr || `rg failed with exit code ${result.exitCode}`);
  }

  const matches: FileSearchMatch[] = [];
  const matchedFiles = new Set<string>();
  let totalMatches = 0;

  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const event = JSON.parse(trimmed) as {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
        line_number?: number;
        submatches?: Array<{ start?: number }>;
      };
    };

    if (event.type !== 'match' || !event.data?.path?.text) {
      continue;
    }

    const relativePath = event.data.path.text;
    const lineText = (event.data.lines?.text ?? '').replace(/\r?\n$/, '');
    const lineNumber = event.data.line_number ?? 1;

    for (const submatch of event.data.submatches ?? []) {
      totalMatches += 1;
      matchedFiles.add(relativePath);

      if (matches.length < SEARCH_MAX_MATCHES) {
        matches.push({
          path: relativePath,
          line: lineNumber,
          column: (submatch.start ?? 0) + 1,
          text: lineText,
        });
      }
    }
  }

  return {
    matches,
    matchedFiles,
    totalMatches,
  };
};

const createFileSearchTool = ({
  workspace,
  security,
}: ToolContext): AgentTool<typeof FileSearchParams> => ({
  name: 'file_search',
  label: 'File Search',
  description:
    'Search workspace files for a literal text pattern. Supports restricting the search to a file or directory and filtering candidate paths with a glob.',
  parameters: FileSearchParams,
  execute: async (_toolCallId, args: FileSearchArgs) => {
    const searchPath = args.path ?? '.';

    if (args.pattern.length === 0) {
      throw new ValidationError('file_search pattern may not be empty.');
    }

    const resolvedTarget = await security.checkPath(searchPath, {
      mustExist: true,
      kind: 'any',
    });

    const globMatcher = args.glob
      ? globToRegExp(args.glob.split(path.sep).join(path.posix.sep))
      : undefined;

    const candidates = await collectSearchCandidates(
      workspace,
      resolvedTarget,
      globMatcher,
    );

    const searchableCandidates: SearchCandidate[] = [];
    const skippedLargeFiles: string[] = [];

    for (const candidate of candidates) {
      const stats = await fs.stat(candidate.absolutePath);
      if (stats.size > SEARCH_MAX_FILE_BYTES) {
        skippedLargeFiles.push(candidate.relativePath);
        continue;
      }

      searchableCandidates.push(candidate);
    }

    const searchResult =
      (await isRipgrepAvailable())
        ? await searchCandidatesWithRipgrep(
            workspace,
            searchableCandidates,
            args.pattern,
          ).catch(async () =>
            searchCandidatesWithNode(searchableCandidates, args.pattern),
          )
        : await searchCandidatesWithNode(searchableCandidates, args.pattern);

    const details: FileSearchResultDetails = {
      pattern: args.pattern,
      path: searchPath,
      ...(args.glob ? { glob: args.glob } : {}),
      scannedFiles: candidates.length,
      matchedFiles: searchResult.matchedFiles.size,
      totalMatches: searchResult.totalMatches,
      returnedMatches: searchResult.matches.length,
      truncated: searchResult.totalMatches > searchResult.matches.length,
      skippedLargeFiles,
      matches: searchResult.matches,
    };

    return {
      content: asTextContent(formatSearchSummary(details)),
      details,
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
    description: 'Fully-qualified URL to fetch over HTTP(S).',
  }),
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
    'Perform an HTTP GET request and return the response body as text. Useful for reading documentation or checking public URLs. Responses are truncated at max_bytes to avoid flooding the context window.',
  parameters: WebFetchParams,
  execute: async (_toolCallId, args: WebFetchArgs) => {
    const url = new URL(args.url);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(`web_fetch only supports http/https URLs, got: ${url.protocol}`);
    }

    const requestedBytes = args.max_bytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isFinite(requestedBytes) || requestedBytes < 1) {
      throw new ValidationError('web_fetch max_bytes must be a positive number.');
    }

    const limit = Math.min(Math.floor(requestedBytes), MAX_RESPONSE_BYTES);
    const response = await fetch(url, { method: 'GET' });

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
      method: 'GET',
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
    createFileSearchTool(context),
    createDeleteFileTool(context),
    createContainerRunTool(context),
    createContainerStatusTool(context),
    createWebFetchTool(),
    createContainerStartTool(context),
    createContainerStopTool(context),
    createContainerExecTool(context),
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
