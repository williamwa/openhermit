import type { AgentLocalClient } from '@openhermit/sdk';
import process from 'node:process';
import { Key, matchesKey } from '@mariozechner/pi-tui';

import { HELP_TEXT } from '../constants.js';
import {
  formatDebugValue,
  formatSessionList,
} from '../formatting.js';
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
  resumeFlag?: boolean | undefined;
}

// ─── Main loop ────────────────────────────────────────────────────────────────

export const runTuiChatLoop = async (opts: TuiChatLoopOptions): Promise<void> => {
  const { client, token, agentId, workspaceRoot, startupSession, resumeFlag } = opts;

  const layout = createTuiLayout();
  const {
    tui,
    editor,
    setHeader,
    addText,
    addStatusLine,
    addAgentLabel,
    beginAssistantMessage,
  } = layout;

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
  addText(gray('Type /help for commands. /exit or double Ctrl-C to exit.\n'));

  // ── open initial session ──────────────────────────────────────────────────

  await client.openSession(createCliSessionSpec(currentSessionId));

  // ── start TUI ─────────────────────────────────────────────────────────────

  tui.start();
  tui.requestRender();

  // ── exit signal ───────────────────────────────────────────────────────────

  let triggerExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    triggerExit = resolve;
  });

  // Abort controller for the in-flight assistant turn (if any),
  // so Ctrl-C can cancel long-running waits.
  let currentTurnAbort: AbortController | null = null;
  let sigintHandler: ((signal: NodeJS.Signals) => void) | null = null;

  const handleInterrupt = (): void => {
    if (currentTurnAbort) {
      if (!currentTurnAbort.signal.aborted) {
        currentTurnAbort.abort();
        addText(gray('[cancelled current turn]'));
        tui.requestRender();
        return;
      }

      triggerExit();
      return;
    }

    triggerExit();
  };

  const removeInputListener = tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl('c'))) {
      handleInterrupt();
      return { consume: true };
    }

    if (matchesKey(data, Key.ctrl('d'))) {
      triggerExit();
      return { consume: true };
    }

    return undefined;
  });

  const handleSigint = (): void => {
    if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
      currentTurnAbort.abort();
      addText(gray('[cancelled current turn]'));
      tui.requestRender();
      return;
    }
    triggerExit();
  };

  // Use process-level SIGINT so Ctrl-C always works, regardless of how
  // the terminal library encodes it.
  sigintHandler = () => {
    handleSigint();
  };
  process.on('SIGINT', sigintHandler);

  // ── input handling ────────────────────────────────────────────────────────

  editor.onSubmit = (text: string): void => {
    const input = text.trim();
    if (!input) return;

    editor.disableSubmit = true;
    editor.addToHistory(text);
    editor.setText('');

    handleInput(input)
      .catch((err: unknown) => {
        if (err instanceof Error && err.message === 'Assistant turn cancelled.') {
          // Silent cancel on Ctrl-C/Ctrl-D; don't show as an error.
          return;
        }
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
        if (currentTurnAbort && !currentTurnAbort.signal.aborted) {
          currentTurnAbort.abort();
        }
        triggerExit();
        return;
      }

      if (command.type === 'help') {
        addText(HELP_TEXT);
        return;
      }

      if (command.type === 'new') {
        await client.checkpointSession(currentSessionId, {
          reason: 'new_session',
        });
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

    const currentLastEventId = knownEventIds.get(currentSessionId) ?? 0;

    await client.postMessage(currentSessionId, { text: input });
    addAgentLabel();

    // Create a fresh abort controller for this turn so we can cancel
    // waitForAssistantTurn when the user hits Ctrl-C.
    currentTurnAbort = new AbortController();
    let thinkingHandle: ReturnType<typeof addStatusLine> | null = addStatusLine(
      gray('[thinking...]'),
    );
    let agentLabelShown = true;
    const clearThinking = () => {
      if (!thinkingHandle) {
        return;
      }

      thinkingHandle.remove();
      thinkingHandle = null;
    };
    const ensureAgentLabel = () => {
      clearThinking();
      if (agentLabelShown) {
        return;
      }

      addAgentLabel();
      agentLabelShown = true;
    };
    let assistantHandle: ReturnType<typeof beginAssistantMessage> | null = null;
    const ensureAssistantHandle = () => {
      clearThinking();
      if (!assistantHandle) {
        assistantHandle = beginAssistantMessage(!agentLabelShown);
        agentLabelShown = true;
      }

      return assistantHandle;
    };

    let nextEventId: number | null = null;
    const promptApproval = async (): Promise<boolean> => {
      const promptHandle = addStatusLine(gray('Approve? [y/N]'));
      const previousDisableSubmit = editor.disableSubmit;
      editor.disableSubmit = true;
      tui.requestRender();

      return await new Promise<boolean>((resolve) => {
        const finish = (approved: boolean) => {
          removeApprovalListener();
          promptHandle.remove();
          editor.disableSubmit = previousDisableSubmit;
          tui.requestRender();
          resolve(approved);
        };

        const removeApprovalListener = tui.addInputListener((data) => {
          if (matchesKey(data, Key.enter)) {
            finish(false);
            return { consume: true };
          }

          if (matchesKey(data, Key.escape)) {
            finish(false);
            return { consume: true };
          }

          if (data === 'y' || data === 'Y') {
            finish(true);
            return { consume: true };
          }

          if (data === 'n' || data === 'N') {
            finish(false);
            return { consume: true };
          }

          return undefined;
        });
      });
    };

    try {
      nextEventId = await waitForAssistantTurn(
        client,
        token,
        currentSessionId,
        currentLastEventId,
        {
          signal: currentTurnAbort.signal,
          onApprovalRequired: async (_toolName, _toolCallId, _args) => {
            ensureAgentLabel();
            const approved = await promptApproval();
            addText(approved ? green('[approved]') : red('[denied]'));
            return approved;
          },
          output: {
            onTextDelta: (delta) => {
              ensureAssistantHandle().appendDelta(delta);
            },
            onTextFinal: (fullText, sawDelta) => {
              ensureAssistantHandle().finalise(fullText, sawDelta);
            },
            onToolRequested: (tool, args) => {
              ensureAgentLabel();
              const formatted = formatDebugValue(args);
              const suffix = formatted
                ? formatted.includes('\n')
                  ? `\n${gray(formatted)}`
                  : ` ${gray(formatted)}`
                : '';
              addText(`${gray('[tool requested]')} ${yellow(tool)}${suffix}`);
            },
            onToolStarted: (tool, args) => {
              ensureAgentLabel();
              const formatted = formatDebugValue(args);
              const suffix = formatted
                ? formatted.includes('\n')
                  ? `\n${gray(formatted)}`
                  : ` ${gray(formatted)}`
                : '';
              addText(`${gray('[tool]')} ${yellow(tool)}${suffix}`);
            },
            onToolResult: (tool, isError) => {
              ensureAgentLabel();
              const label = isError ? red('[tool error]') : gray('[tool result]');
              addText(`${label} ${yellow(tool)}`);
            },
            onApprovalPrompt: (toolName, args) => {
              ensureAgentLabel();
              // Layout will show overlay; we just show a label in the feed too
              const formatted = formatDebugValue(args);
              const suffix = formatted ? ` ${gray(formatted)}` : '';
              addText(`${yellow('[approval required]')} ${bold(toolName)}${suffix}`);
            },
            onError: (message) => {
              ensureAgentLabel();
              addText(`${red('[error]')} ${message}`);
            },
          },
        },
      );
    } finally {
      if (thinkingHandle) {
        thinkingHandle.remove();
      }
      currentTurnAbort = null;
    }

    if (nextEventId !== null) {
      knownEventIds.set(currentSessionId, nextEventId);
    }
  };

  // ── wait for exit ─────────────────────────────────────────────────────────
  await exitPromise;

  if (sigintHandler) {
    process.off('SIGINT', sigintHandler);
  }
  removeInputListener();

  await layout.terminal.drainInput().catch(() => undefined);
  tui.stop();
};
