import { HELP_TEXT } from './constants.js';
import type { CliCommand } from './types.js';

export const parseSlashCommand = (input: string): CliCommand | null => {
  const trimmed = input.trim();

  if (!trimmed.startsWith('/')) {
    return null;
  }

  const [command, ...args] = trimmed.split(/\s+/);

  switch (command) {
    case '/exit':
      if (args.length > 0) {
        throw new Error('Usage: /exit');
      }

      return { type: 'exit' };

    case '/help':
      if (args.length > 0) {
        throw new Error('Usage: /help');
      }

      return { type: 'help' };

    case '/new':
      if (args.length > 0) {
        throw new Error('Usage: /new');
      }

      return { type: 'new' };

    case '/sessions':
      if (args.length > 0) {
        throw new Error('Usage: /sessions');
      }

      return { type: 'sessions' };

    case '/resume':
      if (args.length !== 1) {
        throw new Error('Usage: /resume <sessionId>');
      }

      return {
        type: 'resume',
        sessionId: args[0]!,
      };

    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP_TEXT}`);
  }
};
