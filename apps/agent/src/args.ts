export interface AgentCliOptions {
  agentId: string;
  port?: number;
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

const HELP_TEXT = [
  'Usage: npm run dev:agent -- [--agent-id <id>] [--port <port>]',
  '',
  'Flags:',
  '  --agent-id <id>     Agent identifier used under ~/.openhermit/',
  '  --port <port>       Override the HTTP API port for this process',
].join('\n');

export const parseAgentCliArgs = (
  argv: string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): AgentCliOptions => {
  let agentId = env.OPENHERMIT_AGENT_ID ?? 'main';
  let port = env.PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--agent-id') {
      agentId = parseFlagValue(argv, index, '--agent-id');
      index += 1;
      continue;
    }

    if (arg === '--port') {
      port = parseFlagValue(argv, index, '--port');
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      throw new Error(HELP_TEXT);
    }

    throw new Error(`Unknown argument: ${arg}\n\n${HELP_TEXT}`);
  }

  return {
    agentId,
    ...(port ? { port: parsePort(port, port === env.PORT ? 'PORT' : '--port') } : {}),
  };
};
