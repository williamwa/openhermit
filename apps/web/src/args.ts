import path from 'node:path';

export interface WebCliOptions {
  agentId: string;
  workspaceRoot: string;
  port: number;
}

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

const parsePort = (value: string, flag: string): number => {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port for ${flag}: ${value}`);
  }

  return parsed;
};

export const resolveWorkspaceRoot = (
  cwd: string,
  agentId: string,
  explicitWorkspaceRoot?: string,
): string =>
  explicitWorkspaceRoot
    ? path.resolve(cwd, explicitWorkspaceRoot)
    : path.join(cwd, '.openhermit-dev', agentId);

export const parseWebCliArgs = (
  argv: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): WebCliOptions => {
  let agentId = env.OPENHERMIT_AGENT_ID ?? 'agent-dev';
  let explicitWorkspaceRoot = env.OPENHERMIT_WORKSPACE_ROOT;
  let port = parsePort(env.OPENHERMIT_WEB_PORT ?? '4310', 'OPENHERMIT_WEB_PORT');

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

    if (arg === '--port') {
      port = parsePort(parseFlagValue(argv, index, '--port'), '--port');
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    agentId,
    workspaceRoot: resolveWorkspaceRoot(cwd, agentId, explicitWorkspaceRoot),
    port,
  };
};
