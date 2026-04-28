import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Message } from '@mariozechner/pi-ai';

import type { SessionMessage } from '@openhermit/protocol';

export const isAssistantMessage = (
  message: AgentMessage,
): message is AssistantMessage =>
  typeof message === 'object' &&
  message !== null &&
  'role' in message &&
  message.role === 'assistant';

export const extractAssistantText = (message: AssistantMessage): string => {
  const textParts = message.content
    .filter((content): content is Extract<typeof content, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text.trim())
    .filter((text) => text.length > 0);

  return textParts.join('\n\n');
};

export const extractThinkingText = (message: AssistantMessage): string => {
  const parts = message.content
    .filter((content): content is Extract<typeof content, { type: 'thinking' }> =>
      content.type === 'thinking' && 'thinking' in content && typeof (content as any).thinking === 'string')
    .map((content) => (content as any).thinking.trim())
    .filter((text: string) => text.length > 0);

  return parts.join('\n\n');
};

// Some OpenAI-compatible providers (e.g. DeepSeek with reasoning_content,
// llama.cpp, gpt-oss) require the prior reasoning to be passed back on the
// exact provider-specific field. The pi-ai provider records that field name
// on the thinking block as `thinkingSignature` so it can echo it correctly.
// We need to persist it so resumed sessions don't lose it.
export const extractThinkingSignature = (message: AssistantMessage): string | undefined => {
  for (const block of message.content) {
    if (block.type !== 'thinking') continue;
    const sig = (block as { thinkingSignature?: unknown }).thinkingSignature;
    if (typeof sig === 'string' && sig.length > 0) return sig;
  }
  return undefined;
};

export const hasMeaningfulAssistantText = (text: string): boolean =>
  text.trim().length > 0;

export const createUserMessage = (message: SessionMessage): Message => {
  const text =
    message.attachments && message.attachments.length > 0
      ? `${message.text}\n\n[Attachments are not yet mapped into the model context. Count: ${message.attachments.length}]`
      : message.text;

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
      },
    ],
    timestamp: Date.now(),
  };
};

export const serializeDetails = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

export const extractToolResultText = (result: unknown): string | undefined => {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const content = 'content' in result ? result.content : undefined;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter(
      (entry): entry is { type: 'text'; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'text' &&
        'text' in entry &&
        typeof entry.text === 'string',
    )
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join('\n');
};

export const extractToolResultDetails = (result: unknown): unknown => {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  if (!('details' in result)) {
    return undefined;
  }

  return result.details;
};
