/**
 * Format agent responses for Telegram.
 * Handles message splitting for long responses (Telegram limit: 4096 chars).
 */

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Split a long response into chunks that fit within Telegram's message limit.
 * Tries to split on paragraph boundaries first, then sentence boundaries.
 */
export const formatAgentResponse = (text: string): string[] => {
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
};
