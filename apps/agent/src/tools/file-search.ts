import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ValidationError } from '@openhermit/shared';

import { type AgentWorkspace } from '../core/index.js';
import { type ToolContext, asTextContent } from './shared.js';

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

export const createFileSearchTool = ({
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
