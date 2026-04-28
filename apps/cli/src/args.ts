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

export const parseChatCliArgs = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ChatCliOptions => {
  let agentId = env.OPENHERMIT_AGENT_ID ?? 'main';
  let sessionId: string | undefined;
  let resume = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--agent') {
      agentId = parseFlagValue(argv, index, '--agent');
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
    ...(sessionId ? { sessionId } : {}),
    ...(resume ? { resume } : {}),
  };
};
