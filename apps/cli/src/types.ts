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

export interface AssistantTurnOptions {
  onApprovalRequired?: (
    toolName: string,
    toolCallId: string,
    args: unknown,
  ) => Promise<boolean>;
}

export interface StartupSessionSelection {
  sessionId: string;
  lastEventId: number;
  resumed: boolean;
}
