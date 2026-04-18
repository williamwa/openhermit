/**
 * Format agent responses for Telegram.
 * Converts Markdown to Telegram-compatible HTML and handles message splitting
 * for long responses (Telegram limit: 4096 chars).
 */

import { marked } from 'marked';

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Telegram only supports: b, strong, i, em, u, ins, s, strike, del,
 * span (with class="tg-spoiler"), a, code, pre.
 */
function markdownToTelegramHtml(md: string): string {
  const html = marked.parse(md, { async: false }) as string;

  return (
    html
      // Strip <p> wrappers → double newline
      .replace(/<p>/g, '')
      .replace(/<\/p>/g, '\n')
      // Convert headings to bold
      .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/g, '<b>$1</b>\n')
      // Convert <li> to bullet lines
      .replace(/<li>/g, '• ')
      .replace(/<\/li>/g, '\n')
      // Strip unsupported wrapper tags (ul, ol, div, br, hr, etc.)
      .replace(/<\/?(?:ul|ol|div|br|hr|blockquote|table|thead|tbody|tr|td|th|img)[^>]*>/g, '')
      // Collapse excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * Split a long response into chunks that fit within Telegram's message limit.
 * Tries to split on paragraph boundaries first, then sentence boundaries.
 */
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split on a double newline (paragraph boundary).
    let splitIndex = remaining.lastIndexOf('\n\n', TELEGRAM_MAX_LENGTH);

    // Fall back to single newline.
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    }

    // Fall back to space.
    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', TELEGRAM_MAX_LENGTH);
    }

    // Hard split if nothing works.
    if (splitIndex <= 0) {
      splitIndex = TELEGRAM_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export interface FormattedChunk {
  text: string;
  parseMode: 'HTML';
}

export { markdownToTelegramHtml };

export const formatAgentResponse = (text: string): FormattedChunk[] => {
  const html = markdownToTelegramHtml(text);
  return splitMessage(html).map((chunk) => ({
    text: chunk,
    parseMode: 'HTML' as const,
  }));
};
