import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import { complete } from '@mariozechner/pi-ai';
import type { DatabaseSync } from 'node:sqlite';
import type { SessionHistoryMessage, SessionListQuery, SessionMessage, SessionSpec, SessionSummary } from '@openhermit/protocol';
import { NotFoundError, ValidationError, getErrorMessage } from '@openhermit/shared';

import {
  AgentSecurity,
  AgentWorkspace,
  DockerContainerManager,
  type AgentConfig,
} from './core/index.js';
import { ApprovalGate } from './agent-runner/approval-gate.js';
import { buildSystemPrompt } from './agent-runner/prompt.js';
import { buildSessionSummaries, createPersistedSessionIndexEntry } from './agent-runner/session-index.js';
import type { AgentRunnerOptions, RunnerSession } from './agent-runner/types.js';
import {
  createProviderSecretCandidates,
  formatMissingApiKeyMessage,
  resolveModel,
} from './agent-runner/model-utils.js';
import {
  createUserMessage,
  extractAssistantText,
  hasMeaningfulAssistantText,
  extractToolResultDetails,
  extractToolResultText,
  isAssistantMessage,
  serializeDetails,
} from './agent-runner/message-utils.js';
import {
  SessionIndexStore,
  SessionLogWriter,
} from './session-logs.js';
import {
  createFallbackDescription,
  normalizeGeneratedDescription,
} from './session-utils.js';
import { type SessionDescriptor, SessionEventBroker, type SessionRuntime } from './runtime.js';
import {
  type ApprovalCallback,
  type ApprovalDecision,
  type ToolRequestedCallback,
  type ToolStartedCallback,
  createBuiltInTools,
} from './tools.js';
import { openInternalStateDatabase } from './internal-state/sqlite.js';

export class AgentRunner implements SessionRuntime {
  readonly events = new SessionEventBroker();

  private static readonly DEFAULT_IDLE_SUMMARY_TIMEOUT_MS = 10 * 60_000;

  private static readonly DEFAULT_CHECKPOINT_TURN_INTERVAL = 50;

  private readonly containerManager: DockerContainerManager;

  private readonly sessionIndex: SessionIndexStore;

  private readonly logWriter: SessionLogWriter;

  private readonly sessions = new Map<string, RunnerSession>();

  private readonly internalStateDatabase: DatabaseSync;

  private constructor(private readonly options: AgentRunnerOptions) {
    this.internalStateDatabase = openInternalStateDatabase(
      options.security.stateFilePath,
    );
    this.containerManager =
      options.containerManager ?? new DockerContainerManager(options.workspace);
    this.sessionIndex = new SessionIndexStore(this.internalStateDatabase);
    this.logWriter = new SessionLogWriter(this.internalStateDatabase);
  }

  static async create(options: AgentRunnerOptions): Promise<AgentRunner> {
    return new AgentRunner(options);
  }

  async openSession(spec: SessionSpec): Promise<SessionDescriptor> {
    const existing = this.sessions.get(spec.sessionId);
    const now = new Date().toISOString();

    if (existing) {
      this.clearIdleSummaryTimer(existing);
      const mergedMetadata = {
        ...(existing.spec.metadata ?? {}),
        ...(spec.metadata ?? {}),
      };

      existing.spec = {
        ...existing.spec,
        ...spec,
        source: {
          ...existing.spec.source,
          ...spec.source,
        },
        ...(Object.keys(mergedMetadata).length > 0
          ? { metadata: mergedMetadata }
          : {}),
      };
      existing.updatedAt = now;
      existing.status = 'idle';
      await this.persistSessionIndex(existing);

      return {
        spec: existing.spec,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }

    const persisted = await this.sessionIndex.get(spec.sessionId);
    const mergedMetadata = {
      ...(persisted?.metadata ?? {}),
      ...(spec.metadata ?? {}),
    };
    const effectiveSpec: SessionSpec = {
      ...spec,
      source: {
        ...(persisted?.source ?? {}),
        ...spec.source,
      },
      ...(Object.keys(mergedMetadata).length > 0
        ? { metadata: mergedMetadata }
        : {}),
    };
    const createdAt = persisted?.createdAt ?? now;

    const config = await this.options.workspace.readConfig();
    const approvalGate = new ApprovalGate();
    const approvalCallback = effectiveSpec.source.interactive
      ? this.makeApprovalCallback(effectiveSpec.sessionId, approvalGate)
      : undefined;
    let session: RunnerSession | undefined;
    const agent = await this.createAgent(
      effectiveSpec,
      config,
      approvalCallback,
      (...args) => {
        if (!session) {
          throw new Error('Session was not initialized before tool execution was requested.');
        }

        return this.makeToolRequestedCallback(session)(...args);
      },
      (...args) => {
        if (!session) {
          throw new Error('Session was not initialized before tool execution started.');
        }

        return this.makeToolStartedCallback(session)(...args);
      },
    );
    session = {
      spec: effectiveSpec,
      createdAt,
      updatedAt: now,
      agent,
      queue: Promise.resolve(),
      sideEffects: Promise.resolve(),
      backgroundTasks: Promise.resolve(),
      checkpointInProgress: false,
      idleSummaryTimer: undefined,
      latestAssistantText: undefined,
      approvalGate,
      status: 'idle',
      messageCount: persisted?.messageCount ?? 0,
      completedTurnCount: persisted?.completedTurnCount ?? 0,
      lastSummarizedHistoryCount: persisted?.lastSummarizedHistoryCount ?? 0,
      lastSummarizedTurnCount: persisted?.lastSummarizedTurnCount ?? 0,
      ...(persisted?.lastSummarizedAt
        ? { lastSummarizedAt: persisted.lastSummarizedAt }
        : {}),
      ...(persisted?.description ? { description: persisted.description } : {}),
      ...(persisted?.descriptionSource
        ? { descriptionSource: persisted.descriptionSource }
        : {}),
      ...(persisted?.lastMessagePreview
        ? { lastMessagePreview: persisted.lastMessagePreview }
        : {}),
    };

    agent.subscribe((event) => {
      this.handleAgentEvent(session, event);
    });

    this.sessions.set(spec.sessionId, session);
    await this.persistSessionIndex(session);
    if (!persisted) {
      await this.logWriter.writeSessionStarted(effectiveSpec, {
        provider: config.model.provider,
        model: config.model.model,
      });
    }

    return {
      spec: session.spec,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  getSession(sessionId: string): SessionDescriptor | undefined {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    return {
      spec: session.spec,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async listSessions(query: SessionListQuery = {}): Promise<SessionSummary[]> {
    const persistedSessions = await this.sessionIndex.list();
    const limit = query.limit;
    const summaries = buildSessionSummaries(
      persistedSessions,
      this.sessions.values(),
      query,
      (sessionId) => this.events.getBacklog(sessionId).at(-1)?.id ?? 0,
    );

    return limit !== undefined ? summaries.slice(0, limit) : summaries;
  }

  async listSessionMessages(sessionId: string): Promise<SessionHistoryMessage[]> {
    const activeSession = this.sessions.get(sessionId);

    if (activeSession) {
      await activeSession.sideEffects;
      return this.logWriter.listHistoryMessages(activeSession.spec.sessionId);
    }

    const persisted = await this.sessionIndex.get(sessionId);

    if (!persisted) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return this.logWriter.listHistoryMessages(persisted.sessionId);
  }

  async listEpisodicEntries(sessionId: string) {
    const activeSession = this.sessions.get(sessionId);

    if (activeSession) {
      await activeSession.sideEffects;
      return this.logWriter.listEpisodicEntries(activeSession.spec.sessionId);
    }

    const persisted = await this.sessionIndex.get(sessionId);

    if (!persisted) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return this.logWriter.listEpisodicEntries(persisted.sessionId);
  }

  /**
   * Resolve a pending tool approval for the given session.
   * Called by the HTTP `POST /sessions/:id/approve` endpoint.
   * Returns true if a pending approval was found and resolved, false otherwise.
   */
  respondToApproval(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
  ): boolean {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return false;
    }

    return session.approvalGate.respond(toolCallId, approved);
  }

  async checkpointSession(
    sessionId: string,
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle' = 'manual',
  ): Promise<boolean> {
    const session = this.getRequiredSession(sessionId);
    return this.runSessionCheckpoint(session, reason);
  }

  async waitForSessionIdle(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    await session.queue;
    await session.sideEffects;
    await session.backgroundTasks;
    await this.sessionIndex.waitForIdle();
  }

  private getIdleSummaryTimeoutMs(): number {
    return this.options.idleSummaryTimeoutMs
      ?? AgentRunner.DEFAULT_IDLE_SUMMARY_TIMEOUT_MS;
  }

  private getCheckpointTurnInterval(config?: AgentConfig): number {
    return (
      this.options.checkpointTurnInterval
      ?? config?.memory.checkpoint_turn_interval
      ?? AgentRunner.DEFAULT_CHECKPOINT_TURN_INTERVAL
    );
  }

  private clearIdleSummaryTimer(session: RunnerSession): void {
    if (!session.idleSummaryTimer) {
      return;
    }

    clearTimeout(session.idleSummaryTimer);
    session.idleSummaryTimer = undefined;
  }

  private scheduleIdleSummary(session: RunnerSession): void {
    this.clearIdleSummaryTimer(session);
    session.idleSummaryTimer = setTimeout(() => {
      void this.queueBackgroundTask(session, async () => {
        await this.runSessionCheckpoint(session, 'idle');
      });
    }, this.getIdleSummaryTimeoutMs());
    session.idleSummaryTimer.unref?.();
  }

  private async runSessionCheckpoint(
    session: RunnerSession,
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle',
  ): Promise<boolean> {
    if (session.checkpointInProgress) {
      return false;
    }

    session.checkpointInProgress = true;

    try {
      await session.queue;
      await session.sideEffects;

      const chronologicalHistory = await this.logWriter.listCheckpointHistory(
        session.spec.sessionId,
      );
      const newHistory = chronologicalHistory.slice(session.lastSummarizedHistoryCount);

      if (newHistory.length === 0) {
        return false;
      }

      const config = await this.options.workspace.readConfig();
      const previousWorkingMemory = await this.logWriter.getSessionWorkingMemory(
        session.spec.sessionId,
      );
      const checkpointArtifacts = await this.generateCheckpointArtifacts({
        sessionId: session.spec.sessionId,
        reason,
        history: newHistory,
        previousWorkingMemory,
        config,
      });
      const summary = checkpointArtifacts.summary;

      if (!summary) {
        return false;
      }

      const ts = new Date().toISOString();
      const previousHistoryCount = session.lastSummarizedHistoryCount;
      const previousTurnCount = session.lastSummarizedTurnCount;
      session.lastSummarizedHistoryCount = chronologicalHistory.length;
      session.lastSummarizedTurnCount = session.completedTurnCount;
      session.lastSummarizedAt = ts;
      await this.persistSessionIndex(session);

      await this.logWriter.appendEpisodic(session.spec.sessionId, {
        ts,
        session: session.spec.sessionId,
        type: reason === 'turn_limit' ? 'session_checkpoint' : 'session_summary',
        data: {
          reason,
          fromHistoryCount: previousHistoryCount,
          toHistoryCount: session.lastSummarizedHistoryCount,
          turnCount: session.completedTurnCount,
          summarizedTurns: session.completedTurnCount - previousTurnCount,
          summary,
        },
      });

      await this.updateSessionWorkingMemory(
        session,
        checkpointArtifacts.sessionWorkingMemory,
      );

      return true;
    } finally {
      session.checkpointInProgress = false;
    }
  }

  private async updateSessionWorkingMemory(
    session: RunnerSession,
    nextWorkingMemory: string | undefined,
  ): Promise<void> {
    if (!nextWorkingMemory) {
      return;
    }

    await this.logWriter.setSessionWorkingMemory(
      session.spec.sessionId,
      `${nextWorkingMemory.trim()}\n`,
      new Date().toISOString(),
    );
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }> {
    const session = this.getRequiredSession(sessionId);
    this.clearIdleSummaryTimer(session);
    session.updatedAt = new Date().toISOString();
    session.status = 'running';
    session.messageCount += 1;
    session.lastUserMessageText = message.text;
    if (!session.description) {
      const fallbackDescription = createFallbackDescription(message.text);

      if (fallbackDescription) {
        session.description = fallbackDescription;
        session.descriptionSource = 'fallback';
      }
    }
    session.lastMessagePreview = message.text;
    await this.persistSessionIndex(session);

    const receivedAt = new Date().toISOString();
    await this.queueSideEffect(session, async () => {
      await this.logWriter.appendSession(session.spec.sessionId, {
        ts: receivedAt,
        role: 'user',
        messageId: message.messageId,
        content: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
      });
    });

    const run = async (): Promise<void> => {
      try {
        await this.refreshAgentConfiguration(session);
        session.latestAssistantText = undefined;
        await session.agent.prompt(createUserMessage(message));
      } catch (error) {
        await this.handleRunError(session, error);
      }
    };

    session.queue = session.queue.then(run, run);

    if (message.messageId) {
      return {
        sessionId,
        messageId: message.messageId,
      };
    }

    return { sessionId };
  }

  private makeApprovalCallback(
    sessionId: string,
    gate: ApprovalGate,
  ): ApprovalCallback {
    return async (toolName, toolCallId, args) => {
      const session = this.sessions.get(sessionId);

      if (session) {
        await this.recordApprovalRequested(session, toolName, toolCallId, args);
      }

      await this.events.publish({
        type: 'tool_approval_required',
        sessionId,
        toolName,
        toolCallId,
        ...(args !== undefined ? { args } : {}),
      });

      if (session) {
        session.status = 'awaiting_approval';
        session.updatedAt = new Date().toISOString();
      }

      const decision = await gate.request(toolCallId);

      if (session) {
        session.status = 'running';
        session.updatedAt = new Date().toISOString();
        await this.recordApprovalResolved(session, toolName, toolCallId, decision);
      }

      return decision;
    };
  }

  private makeToolStartedCallback(session: RunnerSession): ToolStartedCallback {
    return async (toolName, toolCallId, args) => {
      const ts = new Date().toISOString();
      session.status = 'running';
      session.updatedAt = ts;

      await this.events.publish({
        type: 'tool_started',
        sessionId: session.spec.sessionId,
        tool: toolName,
        ...(args !== undefined ? { args } : {}),
      });

      await this.queueSideEffect(session, async () => {
        await this.logWriter.appendSession(session.spec.sessionId, {
          ts,
          role: 'tool_call',
          type: 'tool_started',
          name: toolName,
          args,
          toolCallId,
        });
      });
    };
  }

  private makeToolRequestedCallback(session: RunnerSession): ToolRequestedCallback {
    return async (toolName, toolCallId, args) => {
      const ts = new Date().toISOString();

      await this.events.publish({
        type: 'tool_requested',
        sessionId: session.spec.sessionId,
        tool: toolName,
        ...(args !== undefined ? { args } : {}),
      });

      await this.queueSideEffect(session, async () => {
        await this.logWriter.appendSession(session.spec.sessionId, {
          ts,
          role: 'tool_call',
          type: 'tool_requested',
          name: toolName,
          args,
          toolCallId,
        });
      });
    };
  }

  private async recordApprovalRequested(
    session: RunnerSession,
    toolName: string,
    toolCallId: string,
    args: unknown,
  ): Promise<void> {
    const ts = new Date().toISOString();

    await this.queueSideEffect(session, async () => {
      await this.logWriter.appendSession(session.spec.sessionId, {
        ts,
        role: 'system',
        type: 'tool_approval_requested',
        toolName,
        toolCallId,
        ...(args !== undefined ? { args } : {}),
      });
    });
  }

  private async recordApprovalResolved(
    session: RunnerSession,
    toolName: string,
    toolCallId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    const ts = new Date().toISOString();

    await this.queueSideEffect(session, async () => {
      await this.logWriter.appendSession(session.spec.sessionId, {
        ts,
        role: 'system',
        type: 'tool_approval_resolved',
        toolName,
        toolCallId,
        decision,
      });
    });
  }

  private async createAgent(
    spec: SessionSpec,
    config: AgentConfig,
    approvalCallback?: ApprovalCallback,
    onToolRequested?: ToolRequestedCallback,
    onToolStarted?: ToolStartedCallback,
  ): Promise<Agent> {
    return this.createConfiguredAgent({
      config,
      agentSessionId: spec.sessionId,
      contextSessionId: spec.sessionId,
      ...(spec.source.interactive && approvalCallback ? { approvalCallback } : {}),
      ...(onToolRequested ? { onToolRequested } : {}),
      ...(onToolStarted ? { onToolStarted } : {}),
    });
  }

  private async createConfiguredAgent(input: {
    config: AgentConfig;
    agentSessionId: string;
    contextSessionId: string;
    approvalCallback?: ApprovalCallback;
    onToolRequested?: ToolRequestedCallback;
    onToolStarted?: ToolStartedCallback;
    extraSystemPrompt?: string;
    tools?: ReturnType<typeof createBuiltInTools>;
  }): Promise<Agent> {
    const baseSystemPrompt = await buildSystemPrompt(
      input.config,
      this.options.workspace,
      this.options.security,
    );
    const systemPrompt = input.extraSystemPrompt
      ? `${baseSystemPrompt}\n\n${input.extraSystemPrompt}`.trim()
      : baseSystemPrompt;
    const tools =
      input.tools
      ?? createBuiltInTools({
        workspace: this.options.workspace,
        security: this.options.security,
        containerManager: this.containerManager,
        ...(input.approvalCallback ? { approvalCallback: input.approvalCallback } : {}),
        ...(input.onToolRequested ? { onToolRequested: input.onToolRequested } : {}),
        ...(input.onToolStarted ? { onToolStarted: input.onToolStarted } : {}),
      });

    return new Agent({
      initialState: {
        systemPrompt,
        model: resolveModel(input.config),
        tools,
        thinkingLevel: 'off',
      },
      sessionId: input.agentSessionId,
      ...(this.options.streamFn ? { streamFn: this.options.streamFn } : {}),
      getApiKey: (provider) => this.resolveApiKey(provider),
      transformContext: (messages, signal) =>
        this.transformContext(input.contextSessionId, messages, signal),
      transport: 'sse',
    });
  }

  private async refreshAgentConfiguration(session: RunnerSession): Promise<void> {
    await this.options.security.load();
    const config = await this.options.workspace.readConfig();
    this.ensureProviderApiKey(config.model.provider);

    const approvalCallback = session.spec.source.interactive
      ? this.makeApprovalCallback(session.spec.sessionId, session.approvalGate)
      : undefined;

    const refreshedAgent = await this.createConfiguredAgent({
      config,
      agentSessionId: session.spec.sessionId,
      contextSessionId: session.spec.sessionId,
      ...(approvalCallback ? { approvalCallback } : {}),
      onToolRequested: this.makeToolRequestedCallback(session),
      onToolStarted: this.makeToolStartedCallback(session),
    });
    session.agent.setModel(resolveModel(config));
    session.agent.setSystemPrompt(refreshedAgent.state.systemPrompt);
    session.agent.setTools(refreshedAgent.state.tools);
    session.agent.sessionId = session.spec.sessionId;
  }

  private async transformContext(
    sessionId: string,
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const sessionWorking =
      (await this.logWriter.getSessionWorkingMemory(sessionId)) ?? '';
    const globalWorking =
      (await this.logWriter.getGlobalWorkingMemory()) ?? '';

    const contextBlocks: AgentMessage[] = [];

    if (sessionWorking.trim()) {
      contextBlocks.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Session-local working memory (read-only context):\n\n${sessionWorking}`,
          },
        ],
        timestamp: Date.now(),
      });
    }

    if (globalWorking.trim()) {
      contextBlocks.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Global working memory (read-only context):\n\n${globalWorking}`,
          },
        ],
        timestamp: Date.now(),
      });
    }

    return contextBlocks.concat(messages);
  }

  private resolveApiKey(provider: string): string | undefined {
    const candidates = createProviderSecretCandidates(provider);

    for (const candidate of candidates) {
      try {
        return this.options.security.resolveSecrets([candidate])[candidate];
      } catch {
        const envValue = process.env[candidate];

        if (envValue) {
          return envValue;
        }
      }
    }

    return undefined;
  }

  private ensureProviderApiKey(provider: string): void {
    const apiKey = this.resolveApiKey(provider);

    if (apiKey) {
      return;
    }

    throw new ValidationError(
      formatMissingApiKeyMessage(
        provider,
        this.options.security.secretsFilePath,
      ),
    );
  }

  private handleAgentEvent(session: RunnerSession, event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start': {
        const ts = new Date().toISOString();
        void this.queueSideEffect(session, async () => {
          await this.logWriter.appendSession(session.spec.sessionId, {
            ts,
            role: 'system',
            type: 'agent_start',
          });
        });
        break;
      }

      case 'message_update': {
        if (event.assistantMessageEvent.type === 'text_delta') {
          void this.events.publish({
            type: 'text_delta',
            sessionId: session.spec.sessionId,
            text: event.assistantMessageEvent.delta,
          });
        }

        if (event.assistantMessageEvent.type === 'error') {
          void this.events.publish({
            type: 'error',
            sessionId: session.spec.sessionId,
            message: event.assistantMessageEvent.error.errorMessage ?? 'Model stream failed.',
          });
        }
        break;
      }

      case 'message_end': {
        if (!isAssistantMessage(event.message)) {
          break;
        }

        const assistantText = extractAssistantText(event.message);
        const assistantMessage = event.message;

        if (!assistantText || !hasMeaningfulAssistantText(assistantText)) {
          break;
        }

        session.latestAssistantText = assistantText;
        const ts = new Date().toISOString();
        session.updatedAt = ts;
        session.messageCount += 1;
        session.completedTurnCount += 1;
        session.lastMessagePreview = assistantText;
        void this.persistSessionIndex(session);

        void this.queueSideEffect(session, async () => {
          await this.logWriter.appendSession(session.spec.sessionId, {
            ts,
            role: 'assistant',
            content: assistantText,
            provider: assistantMessage.provider,
            model: assistantMessage.model,
            usage: assistantMessage.usage,
            stopReason: assistantMessage.stopReason,
          });
        });

        void this.queueBackgroundTask(session, async () => {
          const config = await this.options.workspace.readConfig();

          if (
            session.completedTurnCount - session.lastSummarizedTurnCount >=
            this.getCheckpointTurnInterval(config)
          ) {
            await this.runSessionCheckpoint(session, 'turn_limit');
          }
        });
        break;
      }

      case 'tool_execution_start': {
        break;
      }

      case 'tool_execution_end': {
        const ts = new Date().toISOString();
        const resultText = extractToolResultText(event.result);
        const resultDetails = extractToolResultDetails(event.result);

        void this.events.publish({
          type: 'tool_result',
          sessionId: session.spec.sessionId,
          tool: event.toolName,
          isError: event.isError,
          ...(resultText ? { text: resultText } : {}),
          ...(resultDetails !== undefined ? { details: resultDetails } : {}),
        });

        void this.queueSideEffect(session, async () => {
          await this.logWriter.appendSession(session.spec.sessionId, {
            ts,
            role: 'tool_result',
            name: event.toolName,
            toolCallId: event.toolCallId,
            isError: event.isError,
            content: serializeDetails(event.result),
          });
        });
        break;
      }

      case 'agent_end': {
        const ts = new Date().toISOString();
        const finalText = session.latestAssistantText;
        const lastUserMessageText = session.lastUserMessageText;
        session.updatedAt = ts;
        session.status = 'idle';
        void this.persistSessionIndex(session);
        this.scheduleIdleSummary(session);
        if (lastUserMessageText) {
          void this.queueBackgroundTask(session, async () => {
            await this.maybeGenerateSessionDescription(session, {
              userText: lastUserMessageText,
              ...(finalText ? { assistantText: finalText } : {}),
            });
          });
        }

        void (async () => {
          if (finalText) {
            await this.events.publish({
              type: 'text_final',
              sessionId: session.spec.sessionId,
              text: finalText,
            });
          }

          await this.events.publish({
            type: 'agent_end',
            sessionId: session.spec.sessionId,
          });
        })();

        session.latestAssistantText = undefined;
        void this.queueSideEffect(session, async () => {
          await this.logWriter.appendSession(session.spec.sessionId, {
            ts,
            role: 'system',
            type: 'agent_end',
            messageCount: event.messages.length,
          });
        });
        break;
      }

      default:
        break;
    }
  }

  private async handleRunError(
    session: RunnerSession,
    error: unknown,
  ): Promise<void> {
    const message = getErrorMessage(error);
    const ts = new Date().toISOString();
    this.clearIdleSummaryTimer(session);
    session.updatedAt = ts;
    session.status = 'idle';
    await this.persistSessionIndex(session);

    try {
      await this.events.publish({
        type: 'error',
        sessionId: session.spec.sessionId,
        message,
      });
      await this.events.publish({
        type: 'agent_end',
        sessionId: session.spec.sessionId,
      });
      this.scheduleIdleSummary(session);
      await this.queueSideEffect(session, async () => {
        await this.logWriter.appendSession(session.spec.sessionId, {
          ts,
          role: 'error',
          message,
        });
      });
    } catch (persistenceError) {
      console.error(
        `[openhermit-agent] failed to surface run error for ${session.spec.sessionId}`,
        persistenceError,
      );
    }
  }

  private async queueSideEffect(
    session: RunnerSession,
    work: () => Promise<void>,
  ): Promise<void> {
    const queued = session.sideEffects.then(work, work);
    session.sideEffects = queued.catch((error) => {
      console.error(
        `[openhermit-agent] failed to persist session side effect for ${session.spec.sessionId}`,
        error,
      );
    });
    return queued;
  }

  private async queueBackgroundTask(
    session: RunnerSession,
    work: () => Promise<void>,
  ): Promise<void> {
    const queued = session.backgroundTasks.then(work, work);
    session.backgroundTasks = queued.catch((error) => {
      console.error(
        `[openhermit-agent] failed to run background task for ${session.spec.sessionId}`,
        error,
      );
    });
    return queued;
  }

  private getRequiredSession(sessionId: string): RunnerSession {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return session;
  }

  private async persistSessionIndex(session: RunnerSession): Promise<void> {
    await this.sessionIndex.upsert(createPersistedSessionIndexEntry(session));
  }

  async listSessionLogEntries(sessionId: string) {
    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      await activeSession.sideEffects.catch(() => undefined);
    }
    return this.logWriter.listSessionEntries(sessionId);
  }

  private async maybeGenerateSessionDescription(
    session: RunnerSession,
    input: {
      userText: string;
      assistantText?: string;
    },
  ): Promise<void> {
    if (session.descriptionSource === 'ai') {
      return;
    }

    const config = await this.options.workspace.readConfig();
    const description = await this.generateSessionDescription({
      ...input,
      config,
    });

    if (!description) {
      return;
    }

    session.description = description;
    session.descriptionSource = 'ai';
    await this.persistSessionIndex(session);
  }

  private async generateSessionDescription(input: {
    userText: string;
    assistantText?: string;
    config: AgentConfig;
  }): Promise<string | undefined> {
    if (this.options.sessionDescriptionGenerator) {
      return normalizeGeneratedDescription(
        await this.options.sessionDescriptionGenerator(input),
      );
    }

    if (this.options.streamFn) {
      return undefined;
    }

    const apiKey = this.resolveApiKey(input.config.model.provider);

    if (!apiKey) {
      return undefined;
    }

    const response = await complete(
      resolveModel(input.config),
      {
        systemPrompt: [
          'Generate a short session title for retrieval.',
          'Return plain text only.',
          'Do not use quotes, markdown, or trailing punctuation.',
          'Keep it under 10 words.',
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  `User message: ${input.userText}`,
                  input.assistantText
                    ? `Assistant reply: ${input.assistantText}`
                    : 'Assistant reply: (none yet)',
                ].join('\n'),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey },
    );

    return normalizeGeneratedDescription(extractAssistantText(response));
  }

  private async generateCheckpointSummary(input: {
    sessionId: string;
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
    history: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>;
    config: AgentConfig;
  }): Promise<string | undefined> {
    if (this.options.checkpointSummaryGenerator) {
      return this.normalizeCheckpointSummary(
        await this.options.checkpointSummaryGenerator(input),
      );
    }

    return undefined;
  }

  private createFallbackCheckpointSummary(
    history: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>,
  ): string | undefined {
    const normalized = history
      .map((entry) => {
        const content = entry.content.replace(/\s+/g, ' ').trim();

        if (!content) {
          return undefined;
        }

        const prefix =
          entry.role === 'user'
            ? 'User'
            : entry.role === 'assistant'
              ? 'Agent'
              : 'Error';

        return `${prefix}: ${content}`;
      })
      .filter((entry): entry is string => Boolean(entry));

    if (normalized.length === 0) {
      return undefined;
    }

    return normalized.slice(-4).join(' | ').slice(0, 400);
  }

  private normalizeCheckpointSummary(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async generateSessionWorkingMemory(input: {
    sessionId: string;
    previousWorkingMemory: string | undefined;
    checkpointSummary: string;
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
    config: AgentConfig;
  }): Promise<string | undefined> {
    if (this.options.sessionWorkingMemoryGenerator) {
      return this.normalizeSessionWorkingMemory(
        await this.options.sessionWorkingMemoryGenerator(input),
      );
    }

    return undefined;
  }

  private createFallbackSessionWorkingMemory(input: {
    sessionId: string;
    previousWorkingMemory: string | undefined;
    checkpointSummary: string;
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
  }): string {
    const previous = input.previousWorkingMemory?.trim();

    return [
      '# Session Working Memory',
      '',
      `Session: ${input.sessionId}`,
      `Last update reason: ${input.reason}`,
      '',
      '## Current Context',
      input.checkpointSummary,
      '',
      '## Previous Working Memory',
      previous && previous.length > 0 ? previous : '(none)',
    ].join('\n');
  }

  private normalizeSessionWorkingMemory(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private async generateCheckpointArtifacts(input: {
    sessionId: string;
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
    history: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>;
    previousWorkingMemory: string | undefined;
    config: AgentConfig;
  }): Promise<{
    summary: string | undefined;
    sessionWorkingMemory: string | undefined;
  }> {
    const summaryOverride = await this.generateCheckpointSummary({
      sessionId: input.sessionId,
      reason: input.reason,
      history: input.history,
      config: input.config,
    });

    const workingOverride = summaryOverride
      ? await this.generateSessionWorkingMemory({
          sessionId: input.sessionId,
          previousWorkingMemory: input.previousWorkingMemory,
          checkpointSummary: summaryOverride,
          reason: input.reason,
          config: input.config,
        })
      : undefined;

    if (summaryOverride && workingOverride) {
      return {
        summary: summaryOverride,
        sessionWorkingMemory: workingOverride,
      };
    }

    const internalArtifacts = await this.runInternalCheckpointTurn(input);
    const summary =
      summaryOverride
      ?? internalArtifacts?.summary
      ?? this.createFallbackCheckpointSummary(input.history);

    const sessionWorkingMemory =
      workingOverride
      ?? internalArtifacts?.sessionWorkingMemory
      ?? this.createFallbackSessionWorkingMemory({
        sessionId: input.sessionId,
        previousWorkingMemory: input.previousWorkingMemory,
        checkpointSummary: summary ?? '',
        reason: input.reason,
      });

    return {
      summary: this.normalizeCheckpointSummary(summary),
      sessionWorkingMemory: this.normalizeSessionWorkingMemory(sessionWorkingMemory),
    };
  }

  private async runInternalCheckpointTurn(input: {
    sessionId: string;
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle';
    history: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>;
    previousWorkingMemory: string | undefined;
    config: AgentConfig;
  }): Promise<{
    summary: string | undefined;
    sessionWorkingMemory: string | undefined;
  } | undefined> {
    if (!this.options.streamFn) {
      const apiKey = this.resolveApiKey(input.config.model.provider);

      if (!apiKey) {
        return undefined;
      }
    }

    const checkpointAgent = await this.createConfiguredAgent({
      config: input.config,
      agentSessionId: `${input.sessionId}:checkpoint`,
      contextSessionId: input.sessionId,
      extraSystemPrompt: [
        'Internal checkpoint turn:',
        '- This is an internal self-introspection turn, not a user-facing reply.',
        '- Reflect on the session activity since the last checkpoint.',
        '- Return JSON only with keys "summary" and "sessionWorkingMemory".',
        '- "summary" should be concise episodic memory for future retrieval.',
        '- "sessionWorkingMemory" should be concise markdown for the session-local working memory.',
        '- Do not call tools.',
        '- Do not wrap the JSON in markdown fences.',
      ].join('\n'),
      tools: [],
    });

    const transcript = input.history
      .map((entry) => `${entry.role.toUpperCase()}: ${entry.content}`)
      .join('\n\n')
      .slice(0, 16_000);

    await checkpointAgent.prompt({
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            `Session: ${input.sessionId}`,
            `Reason: ${input.reason}`,
            'New transcript since the last checkpoint:',
            transcript,
            'Previous session-local working memory:',
            input.previousWorkingMemory?.trim() || '(none)',
          ].join('\n\n'),
        },
      ],
      timestamp: Date.now(),
    });
    await checkpointAgent.waitForIdle();

    const assistantMessage = [...checkpointAgent.state.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    const responseText = assistantMessage
      ? extractAssistantText(assistantMessage)
      : undefined;
    const parsed = this.parseInternalCheckpointResponse(responseText);

    if (!parsed) {
      return undefined;
    }

    return {
      summary: this.normalizeCheckpointSummary(parsed.summary),
      sessionWorkingMemory: this.normalizeSessionWorkingMemory(
        parsed.sessionWorkingMemory,
      ),
    };
  }

  private parseInternalCheckpointResponse(
    text: string | undefined,
  ): { summary?: string; sessionWorkingMemory?: string } | undefined {
    if (!text) {
      return undefined;
    }

    const trimmed = text.trim();
    const jsonText = trimmed.startsWith('```')
      ? trimmed
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim()
      : trimmed;

    try {
      const parsed = JSON.parse(jsonText) as {
        summary?: unknown;
        sessionWorkingMemory?: unknown;
      };

      return {
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
        ...(typeof parsed.sessionWorkingMemory === 'string'
          ? { sessionWorkingMemory: parsed.sessionWorkingMemory }
          : {}),
      };
    } catch {
      return undefined;
    }
  }
}
