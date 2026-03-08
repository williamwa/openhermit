import path from 'node:path';

import type { ChatCliOptions } from './types.js';
import { HELP_TEXT } from './constants.js';

const parseFlagValue = (
  argv: string[],
  index: number,
  flag: string,
): string => {
  const value = argv[index + 1];

  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
};

export const resolveWorkspaceRoot = (
  cwd: string,
  agentId: string,
  explicitWorkspaceRoot?: string,
): string =>
  explicitWorkspaceRoot
    ? path.resolve(cwd, explicitWorkspaceRoot)
    : path.join(cwd, '.openhermit-dev', agentId);

export const parseChatCliArgs = (
  argv: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ChatCliOptions => {
  let agentId = env.OPENHERMIT_AGENT_ID ?? 'agent-dev';
  let explicitWorkspaceRoot = env.OPENHERMIT_WORKSPACE_ROOT;
  let sessionId: string | undefined;
  let resume = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--agent-id') {
      agentId = parseFlagValue(argv, index, '--agent-id');
      index += 1;
      continue;
    }

    if (arg === '--workspace') {
      explicitWorkspaceRoot = parseFlagValue(argv, index, '--workspace');
      index += 1;
      continue;
    }

    if (arg === '--session') {
      sessionId = parseFlagValue(argv, index, '--session');
      index += 1;
      continue;
    }

    if (arg === '--resume') {
      resume = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      throw new Error(HELP_TEXT);
    }

    throw new Error(`Unknown argument: ${arg}\n\n${HELP_TEXT}`);
  }

  if (resume && sessionId) {
    throw new Error('Cannot use --resume together with --session.');
  }

  return {
    agentId,
    workspaceRoot: resolveWorkspaceRoot(cwd, agentId, explicitWorkspaceRoot),
    ...(sessionId ? { sessionId } : {}),
    ...(resume ? { resume } : {}),
  };
};
