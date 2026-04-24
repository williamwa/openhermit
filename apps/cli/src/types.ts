export interface ChatCliOptions {
  agentId: string;
  sessionId?: string;
  resume?: boolean;
}

export type CliCommand =
  | { type: 'exit' }
  | { type: 'help' }
  | { type: 'new' }
  | { type: 'sessions' }
  | { type: 'resume'; sessionId: string };

/**
 * Output sink for assistant turn events.
 * When provided, used instead of writing directly to stdout/stderr.
 */
export interface AssistantOutput {
  onThinkingDelta?: (text: string) => void;
  onThinkingFinal?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onTextFinal?: (text: string, sawDelta: boolean) => void;
  onToolCall?: (tool: string, args: unknown) => void;
  onToolResult?: (tool: string, isError: boolean, text: unknown, details: unknown) => void;
  onApprovalPrompt?: (toolName: string, args: unknown) => void;
  onError?: (message: string) => void;
}

export interface AssistantTurnOptions {
  onApprovalRequired?: (
    toolName: string,
    toolCallId: string,
    args: unknown,
  ) => Promise<boolean>;
  /** Optional signal to cancel the current assistant turn (e.g. on Ctrl-C). */
  signal?: AbortSignal;
  /** If provided, event output goes through these callbacks instead of stdout/stderr. */
  output?: AssistantOutput;
}

export interface StartupSessionSelection {
  sessionId: string;
  lastEventId: number;
  resumed: boolean;
}
