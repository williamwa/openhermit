import type { SessionHistoryMessage } from '@openhermit/protocol';

import { formatDebugValue } from '../formatting.js';
import type { TuiLayout } from './layout.js';
import { bold, cyan, dim, gray, red, yellow } from './theme.js';

export const HISTORY_RENDER_LIMIT = 20;

/**
 * Render a slice of past session events into the TUI message area.
 * Used at startup for --resume / --session and when switching with /resume.
 */
export const renderSessionHistory = (
  layout: Pick<TuiLayout, 'addText' | 'addAssistantMessage'>,
  messages: SessionHistoryMessage[],
  limit: number = HISTORY_RENDER_LIMIT,
): void => {
  const slice = messages.slice(-limit);
  if (slice.length === 0) return;

  layout.addText(dim(gray(`── replaying last ${slice.length} message(s) ──`)));

  for (const msg of slice) {
    switch (msg.role) {
      case 'user': {
        const text = msg.content.trim();
        if (text) layout.addText(`${bold(cyan('you'))}> ${text}`);
        break;
      }
      case 'assistant': {
        const text = msg.content.trim();
        if (text) layout.addAssistantMessage(text);
        break;
      }
      case 'tool': {
        if (msg.toolPhase === 'call') {
          const formatted = formatDebugValue(msg.toolArgs);
          const suffix = formatted
            ? formatted.includes('\n')
              ? `\n${gray(formatted)}`
              : ` ${gray(formatted)}`
            : '';
          layout.addText(`${gray('[tool]')} ${yellow(msg.tool ?? '')}${suffix}`);
        } else if (msg.toolPhase === 'result' && msg.toolIsError) {
          layout.addText(`${red('[tool error]')} ${yellow(msg.tool ?? '')}`);
        }
        break;
      }
      case 'error': {
        layout.addText(`${red('[error]')} ${msg.content}`);
        break;
      }
      case 'introspection':
        // Internal observations — not surfaced in the user-facing history.
        break;
    }
  }

  layout.addText(dim(gray('── end of history ──')));
};
