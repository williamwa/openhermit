import { stdout } from 'node:process';

import type { SessionSummary } from '@openhermit/protocol';

const truncateSingleLine = (value: string, maxLength = 72): string => {
  const singleLine = value.replace(/\s+/g, ' ').trim();

  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
};

/** Max length for tool result body in CLI so assistant reply stays visible. */
export const TOOL_RESULT_DISPLAY_MAX = 1500;

export const truncateToolResultForDisplay = (
  body: string,
  max = TOOL_RESULT_DISPLAY_MAX,
): string => {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n... (truncated, ${body.length - max} more characters)`;
};

export const formatDebugValue = (value: unknown): string => {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  const compact = JSON.stringify(value);

  if (compact && compact.length <= 120) {
    return compact;
  }

  return JSON.stringify(value, null, 2);
};

export const formatSessionList = (
  sessions: SessionSummary[],
  currentSessionId?: string,
): string => {
  if (sessions.length === 0) {
    return 'No CLI sessions found.';
  }

  const lines = sessions.map((session) => {
    const marker = session.sessionId === currentSessionId ? '*' : ' ';
    const label = session.description ?? session.lastMessagePreview;
    const preview = label
      ? ` ${truncateSingleLine(label)}`
      : '';

    return `${marker} ${session.sessionId} ${session.lastActivityAt} messages=${session.messageCount}${preview}`;
  });

  return ['CLI sessions (most recent first):', ...lines].join('\n');
};

export const writeToolRequested = (tool: string, args: unknown): void => {
  const formattedArgs = formatDebugValue(args);

  if (!formattedArgs) {
    stdout.write(`\n[tool requested] ${tool}\n`);
    return;
  }

  if (formattedArgs.includes('\n')) {
    stdout.write(`\n[tool requested] ${tool}\n${formattedArgs}\n`);
    return;
  }

  stdout.write(`\n[tool requested] ${tool} ${formattedArgs}\n`);
};

export const writeToolStarted = (tool: string, args: unknown): void => {
  const formattedArgs = formatDebugValue(args);

  if (!formattedArgs) {
    stdout.write(`\n[tool] ${tool}\n`);
    return;
  }

  if (formattedArgs.includes('\n')) {
    stdout.write(`\n[tool] ${tool}\n${formattedArgs}\n`);
    return;
  }

  stdout.write(`\n[tool] ${tool} ${formattedArgs}\n`);
};

export const writeToolResult = (
  tool: string,
  isError: boolean,
  text: unknown,
  details: unknown,
): void => {
  const label = isError ? '[tool error]' : '[tool result]';
  const raw = details !== undefined ? formatDebugValue(details) : formatDebugValue(text);
  const body = truncateToolResultForDisplay(raw);

  if (!body) {
    stdout.write(`${label} ${tool}\n`);
    return;
  }

  if (body.includes('\n')) {
    stdout.write(`${label} ${tool}\n${body}\n`);
    return;
  }

  stdout.write(`${label} ${tool} ${body}\n`);
};
