const SLACK_MAX_LENGTH = 4000;

/**
 * Convert Markdown to Slack mrkdwn format.
 * Slack uses its own flavor: *bold*, _italic_, ~strikethrough~, `code`, ```preformatted```.
 */
export function markdownToSlackMrkdwn(md: string): string {
  return md
    .replace(/\*\*(.*?)\*\*/g, '*$1*')
    .replace(/__(.*?)__/g, '*$1*')
    .replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '_$1_')
    .replace(/~~(.*?)~~/g, '~$1~')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^[-*]\s+/gm, '• ')
    .replace(/^\d+\.\s+/gm, '• ');
}

export function splitMessage(text: string): string[] {
  if (text.length <= SLACK_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf('\n\n', SLACK_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf('\n', SLACK_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = remaining.lastIndexOf(' ', SLACK_MAX_LENGTH);
    if (splitIndex <= 0) splitIndex = SLACK_MAX_LENGTH;

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export function formatAgentResponse(text: string): string[] {
  const mrkdwn = markdownToSlackMrkdwn(text);
  return splitMessage(mrkdwn);
}
