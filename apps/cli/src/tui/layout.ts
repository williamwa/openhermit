import {
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
} from '@mariozechner/pi-tui';

import { formatDebugValue } from '../formatting.js';
import {
  bold,
  cyan,
  dim,
  editorTheme,
  gray,
  green,
  magenta,
  markdownTheme,
  red,
  selectListTheme,
  yellow,
} from './theme.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface TuiLayout {
  tui: TUI;
  terminal: ProcessTerminal;
  header: Text;
  messages: Container;
  editor: Editor;
  /** Update the header line (agent / session info). */
  setHeader(text: string): void;
  /** Append a plain text message (user input, tool events, status lines). */
  addText(text: string): void;
  /** Append a removable status line, useful for transient waiting indicators. */
  addStatusLine(text: string): StatusLineHandle;
  /** Append the standard agent label line. */
  addAgentLabel(): void;
  /** Begin a new streaming assistant response. Returns handle to append deltas. */
  beginAssistantMessage(showLabel?: boolean): AssistantMessageHandle;
  /** Show a yes/no approval overlay. Resolves with the user's choice. */
  requestApproval(toolName: string, args: unknown): Promise<boolean>;
}

export interface AssistantMessageHandle {
  /** Append a streaming text delta. */
  appendDelta(delta: string): void;
  /** Finalise the message (write the complete text if no deltas arrived). */
  finalise(fullText: string, sawDelta: boolean): void;
}

export interface StatusLineHandle {
  remove(): void;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export const createTuiLayout = (): TuiLayout => {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  // Header row
  const header = new Text('', 1, 0);
  tui.addChild(header);

  // Thin separator
  const separator = new Text(gray('─'.repeat(60)), 0, 0);
  tui.addChild(separator);

  // Scrolling message history
  const messages = new Container();
  tui.addChild(messages);

  // Input editor
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  tui.addChild(editor);
  tui.setFocus(editor);

  // ── helpers ──────────────────────────────────────────────────────────────

  const setHeader = (text: string): void => {
    header.setText(text);
    tui.requestRender();
  };

  const addText = (text: string): void => {
    messages.addChild(new Text(text, 1, 0));
    tui.requestRender();
  };

  const addStatusLine = (text: string): StatusLineHandle => {
    const line = new Text(text, 1, 0);
    messages.addChild(line);
    tui.requestRender();

    return {
      remove(): void {
        messages.removeChild(line);
        tui.requestRender();
      },
    };
  };

  const addAgentLabel = (): void => {
    messages.addChild(new Text(`${bold(cyan('agent'))}> `, 1, 0));
    tui.requestRender();
  };

  const beginAssistantMessage = (showLabel = true): AssistantMessageHandle => {
    if (showLabel) {
      addAgentLabel();
    }

    // Markdown body (updated as deltas arrive)
    const md = new Markdown('', 1, 0, markdownTheme);
    messages.addChild(md);
    tui.requestRender();

    // Show a lightweight placeholder so it's clear the agent is working.
    let accumulated = '';
    let hasRealContent = false;
    md.setText('[thinking...]');
    tui.requestRender();

    return {
      appendDelta(delta: string): void {
        if (!hasRealContent) {
          // First real content replaces the thinking placeholder.
          accumulated = delta;
          hasRealContent = true;
        } else {
          accumulated += delta;
        }
        md.setText(accumulated);
        tui.requestRender();
      },
      finalise(fullText: string, sawDelta: boolean): void {
        if (!sawDelta) {
          md.setText(fullText);
          tui.requestRender();
        }
      },
    };
  };

  const requestApproval = (toolName: string, args: unknown): Promise<boolean> => {
    return new Promise((resolve) => {
      // Build description text
      let description = `Allow ${bold(yellow(toolName))}?`;
      const formatted = formatDebugValue(args);
      if (formatted) {
        description += '\n' + gray(formatted);
      }
      const descText = new Text(description, 2, 0);

      const items = [
        { value: 'y', label: green('✓ Approve') },
        { value: 'n', label: red('✗ Deny') },
      ];

      const list = new SelectList(items, 5, selectListTheme);

      const container = new Container();
      container.addChild(descText);
      container.addChild(list);

      const handle = tui.showOverlay(container, {
        anchor: 'center',
        width: 50,
      });

      const finish = (approved: boolean): void => {
        handle.hide();
        resolve(approved);
      };

      list.onSelect = (item) => finish(item.value === 'y');
      list.onCancel = () => finish(false);
    });
  };

  return {
    tui,
    terminal,
    header,
    messages,
    editor,
    setHeader,
    addText,
    addStatusLine,
    addAgentLabel,
    beginAssistantMessage,
    requestApproval,
  };
};
