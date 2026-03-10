export interface ChatCliOptions {
  agentId: string;
  workspaceRoot: string;
  sessionId?: string;
  resume?: boolean;
}

export interface SseFrame {
  id?: number;
  event: string;
  data: string;
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
  onTextDelta?: (text: string) => void;
  onTextFinal?: (text: string, sawDelta: boolean) => void;
  onToolRequested?: (tool: string, args: unknown) => void;
  onToolStarted?: (tool: string, args: unknown) => void;
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
  /** If provided, event output goes through these callbacks instead of stdout/stderr. */
  output?: AssistantOutput;
}

export interface StartupSessionSelection {
  sessionId: string;
  lastEventId: number;
  resumed: boolean;
}
