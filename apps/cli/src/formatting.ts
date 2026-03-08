import { stdout } from 'node:process';

import type { SessionSummary } from '@openhermit/protocol';

const truncateSingleLine = (value: string, maxLength = 72): string => {
  const singleLine = value.replace(/\s+/g, ' ').trim();

  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 3)}...`;
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
  const body = details !== undefined ? formatDebugValue(details) : formatDebugValue(text);

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
