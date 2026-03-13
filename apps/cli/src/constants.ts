export const HELP_TEXT = [
  'Usage: npm run chat:agent -- [--agent-id <id>] [--workspace <path>] [--session <sessionId>] [--resume]',
  '',
  'Commands:',
  '  /new              Create and switch to a new CLI session',
  '  /sessions         List recent CLI sessions',
  '  /resume <id>      Switch to an existing CLI session',
  '  /exit             End the chat session',
  '  /help             Show this help message',
].join('\n');

export const CLI_SESSION_LIMIT = 20;

export const OPENHERMIT_ASCII_ART = [
  '                          __                        _ __ ',
  '  ____  ____  ___  ____  / /_  ___  _________ ___  (_) /_',
  ' / __ \\/ __ \\/ _ \\/ __ \\/ __ \\/ _ \\/ ___/ __ `__ \\/ / __/',
  '/ /_/ / /_/ /  __/ / / / / / /  __/ /  / / / / / / / /_  ',
  '\\____/ .___/\\___/_/ /_/_/ /_/\\___/_/  /_/ /_/ /_/_/\\__/  ',
  '    /_/                                                  ',
].join('\n');
