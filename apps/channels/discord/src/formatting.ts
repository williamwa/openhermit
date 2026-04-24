const DISCORD_MAX_LENGTH = 2000;

export function markdownToDiscord(md: string): string {
  return md
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/^[-*]\s+/gm, '- ');
}

export function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n\n', DISCORD_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = DISCORD_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export function formatAgentResponse(text: string): string[] {
  const formatted = markdownToDiscord(text);
  return splitMessage(formatted);
}
