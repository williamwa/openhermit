import type { AgentLocalClient } from '@openhermit/sdk';

import { HELP_TEXT } from '../constants.js';
import { formatDebugValue, formatSessionList } from '../formatting.js';
import { parseSlashCommand } from '../commands.js';
import {
  createCliSessionSpec,
  createSessionId,
  findCliSession,
  listCliSessions,
} from '../sessions.js';
import { waitForAssistantTurn } from '../sse.js';
import type { StartupSessionSelection } from '../types.js';
import { createTuiLayout } from './layout.js';
import { bold, cyan, dim, gray, green, red, yellow } from './theme.js';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface TuiChatLoopOptions {
  client: AgentLocalClient;
  token: string;
  agentId: string;
  workspaceRoot: string;
  startupSession: StartupSessionSelection;
  resumeFlag?: boolean;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export const runTuiChatLoop = async (opts: TuiChatLoopOptions): Promise<void> => {
  const { client, token, agentId, workspaceRoot, startupSession, resumeFlag } = opts;

  const layout = createTuiLayout();
  const { tui, editor, setHeader, addText, beginAssistantMessage, requestApproval } = layout;

  let currentSessionId = startupSession.sessionId;
  const knownEventIds = new Map<string, number>();
  knownEventIds.set(currentSessionId, startupSession.lastEventId);

  // ── header ────────────────────────────────────────────────────────────────

  const updateHeader = (): void => {
    setHeader(
      `${bold(cyan('agent'))} ${agentId}  ${gray('│')}  ${bold('session')} ${dim(currentSessionId)}`,
    );
  };
  updateHeader();

  // ── startup messages ──────────────────────────────────────────────────────

  if (resumeFlag && startupSession.resumed) {
    addText(gray('[session] Resumed most recent CLI session'));
  }
  addText(gray('Workspace: ' + workspaceRoot));
  addText(gray('Type /help for commands, Ctrl-C to exit.\n'));

  // ── start TUI ─────────────────────────────────────────────────────────────

  tui.start();
  tui.requestRender();

  // ── exit signal ───────────────────────────────────────────────────────────

  let triggerExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    triggerExit = resolve;
  });

  // Ctrl-C exits immediately
  tui.addInputListener((data) => {
    if (data === '\x03') {
      triggerExit();
      return { consume: true };
    }
    return undefined;
  });

  // ── input handling ────────────────────────────────────────────────────────

  editor.onSubmit = (text: string): void => {
    const input = text.trim();
    if (!input) return;

    editor.disableSubmit = true;
    editor.addToHistory(text);
    editor.setText('');

    handleInput(input)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        addText(`${red('[error]')} ${message}`);
      })
      .finally(() => {
        editor.disableSubmit = false;
        tui.requestRender();
      });
  };

  const handleInput = async (input: string): Promise<void> => {
    // ── slash commands ────────────────────────────────────────────────────
    let command;
    try {
      command = parseSlashCommand(input);
    } catch (err: unknown) {
      addText(red((err instanceof Error ? err.message : String(err))));
      return;
    }

    if (command) {
      if (command.type === 'exit') {
        triggerExit();
        return;
      }

      if (command.type === 'help') {
        addText(HELP_TEXT);
        return;
      }

      if (command.type === 'new') {
        currentSessionId = createSessionId();
        await client.openSession(createCliSessionSpec(currentSessionId));
        knownEventIds.set(currentSessionId, 0);
        updateHeader();
        addText(gray(`[session] Switched to ${currentSessionId}`));
        return;
      }

      if (command.type === 'sessions') {
        const sessions = await listCliSessions(client);
        addText(formatSessionList(sessions, currentSessionId));
        return;
      }

      if (command.type === 'resume') {
        const existing = await findCliSession(client, command.sessionId);
        if (!existing) {
          addText(`${red('[error]')} CLI session not found: ${command.sessionId}`);
          return;
        }
        currentSessionId = existing.sessionId;
        await client.openSession(createCliSessionSpec(currentSessionId));
        knownEventIds.set(
          currentSessionId,
          Math.max(knownEventIds.get(currentSessionId) ?? 0, existing.lastEventId),
        );
        updateHeader();
        addText(gray(`[session] Resumed ${currentSessionId}`));
        return;
      }
    }

    // ── regular message ───────────────────────────────────────────────────
    addText(`${bold(cyan('you'))}> ${input}`);

    const assistantHandle = beginAssistantMessage();
    const currentLastEventId = knownEventIds.get(currentSessionId) ?? 0;

    await client.postMessage(currentSessionId, { text: input });

    const nextEventId = await waitForAssistantTurn(
      client,
      token,
      currentSessionId,
      currentLastEventId,
      {
        onApprovalRequired: async (toolName, toolCallId, args) => {
          const approved = await requestApproval(toolName, args);
          addText(approved ? green('[approved]') : red('[denied]'));
          return approved;
        },
        output: {
          onTextDelta: (delta) => {
            assistantHandle.appendDelta(delta);
          },
          onTextFinal: (fullText, sawDelta) => {
            assistantHandle.finalise(fullText, sawDelta);
          },
          onToolRequested: (tool, args) => {
            const formatted = formatDebugValue(args);
            const suffix = formatted
              ? formatted.includes('\n')
                ? `\n${gray(formatted)}`
                : ` ${gray(formatted)}`
              : '';
            addText(`${gray('[tool requested]')} ${yellow(tool)}${suffix}`);
          },
          onToolStarted: (tool, args) => {
            const formatted = formatDebugValue(args);
            const suffix = formatted
              ? formatted.includes('\n')
                ? `\n${gray(formatted)}`
                : ` ${gray(formatted)}`
              : '';
            addText(`${gray('[tool]')} ${yellow(tool)}${suffix}`);
          },
          onToolResult: (tool, isError, text, details) => {
            const label = isError ? red('[tool error]') : gray('[tool result]');
            const body =
              details !== undefined ? formatDebugValue(details) : formatDebugValue(text);
            if (!body) {
              addText(`${label} ${tool}`);
            } else if (body.includes('\n')) {
              addText(`${label} ${tool}\n${gray(body)}`);
            } else {
              addText(`${label} ${tool} ${gray(body)}`);
            }
          },
          onApprovalPrompt: (toolName, args) => {
            // Layout will show overlay; we just show a label in the feed too
            const formatted = formatDebugValue(args);
            const suffix = formatted ? ` ${gray(formatted)}` : '';
            addText(`${yellow('[approval required]')} ${bold(toolName)}${suffix}`);
          },
          onError: (message) => {
            addText(`${red('[error]')} ${message}`);
          },
        },
      },
    );

    knownEventIds.set(currentSessionId, nextEventId);
  };

  // ── wait for exit ─────────────────────────────────────────────────────────
  await exitPromise;

  await layout.terminal.drainInput().catch(() => undefined);
  tui.stop();
};
