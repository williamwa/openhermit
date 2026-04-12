import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { SessionHistoryMessage, SessionListQuery, SessionMessage, SessionSpec, SessionSummary } from '@openhermit/protocol';
import { NotFoundError, ValidationError, getErrorMessage } from '@openhermit/shared';
import {
  type InternalStateStore,
  type StoreScope,
  SqliteInternalStateStore,
} from '@openhermit/store';

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
  createFallbackDescription,
  normalizeGeneratedDescription,
} from './session-utils.js';
import {
  completeWithLangfuseTrace,
  createLangfuseTracedStreamFn,
} from './langfuse.js';
import { type SessionDescriptor, SessionEventBroker, type SessionRuntime } from './runtime.js';
import {
  type ApprovalCallback,
  type ApprovalDecision,
  type ToolRequestedCallback,
  type ToolStartedCallback,
  createBuiltInTools,
} from './tools.js';
import {
  compactContextIfNeeded,
  estimateAgentMessagesTokens,
  estimateTextTokens,
  getContextCompactionMaxTokens,
  truncateToolResults,
} from './agent-runner/context-compaction.js';
import { createWebProvider, type WebProvider } from './web/index.js';

export class AgentRunner implements SessionRuntime {
  readonly events = new SessionEventBroker();

  private static readonly DEFAULT_IDLE_SUMMARY_TIMEOUT_MS = 10 * 60_000;

  private static readonly DEFAULT_CHECKPOINT_TURN_INTERVAL = 50;

  private readonly containerManager: DockerContainerManager;

  private readonly store: InternalStateStore;

  private readonly scope: StoreScope;

  private readonly sessions = new Map<string, RunnerSession>();

  private workspaceIdleTimer: ReturnType<typeof setTimeout> | undefined;

  private static DEBUG = false;

  private logRuntime(message: string): void {
    console.log(`[openhermit-agent] ${message}`);
  }

  private logDebug(message: string): void {
    if (AgentRunner.DEBUG) {
      console.log(`[openhermit-debug] ${message}`);
    }
  }

  private constructor(private readonly options: AgentRunnerOptions) {
    this.store = options.store
      ?? SqliteInternalStateStore.open(options.security.stateFilePath);
    this.scope = { agentId: options.security.agentId };
    this.containerManager =
      options.containerManager
      ?? new DockerContainerManager(options.workspace, {
        agentId: options.security.agentId,
        containerStore: this.store.containers,
        storeScope: this.scope,
      });
  }

  static async create(options: AgentRunnerOptions): Promise<AgentRunner> {
    AgentRunner.DEBUG = Boolean(process.env.OPENHERMIT_DEBUG);
    return new AgentRunner(options);
  }

  resetWorkspaceIdleTimer(config: import('./core/types.js').WorkspaceContainerConfig): void {
    if (this.workspaceIdleTimer) {
      clearTimeout(this.workspaceIdleTimer);
      this.workspaceIdleTimer = undefined;
    }

    const stopPolicy = config.lifecycle?.stop ?? 'idle';

    if (stopPolicy !== 'idle') {
      return;
    }

    const timeoutMs = (config.lifecycle?.idle_timeout_minutes ?? 30) * 60_000;

    this.workspaceIdleTimer = setTimeout(() => {
      this.workspaceIdleTimer = undefined;
      void this.containerManager
        .stopWorkspaceContainer(this.scope.agentId)
        .then(() => this.logRuntime('workspace container stopped (idle timeout)'))
        .catch(() => {});
    }, timeoutMs);
  }

  async stopWorkspaceContainerIfSessionPolicy(): Promise<void> {
    const config = await this.options.security.readConfig();

    if (this.workspaceIdleTimer) {
      clearTimeout(this.workspaceIdleTimer);
      this.workspaceIdleTimer = undefined;
    }

    if (
      config.workspace_container &&
      (config.workspace_container.lifecycle?.stop ?? 'idle') === 'session'
    ) {
      await this.containerManager.stopWorkspaceContainer(this.scope.agentId);
      this.logRuntime('workspace container stopped (session end)');
    }
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

    const persisted = await this.store.sessions.get(this.scope,spec.sessionId);
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

    const config = await this.options.security.readConfig();

    if (
      config.workspace_container &&
      (config.workspace_container.lifecycle?.start ?? 'ondemand') === 'session'
    ) {
      await this.containerManager.ensureWorkspaceContainer(
        this.scope.agentId,
        config.workspace_container,
      );
      this.logRuntime(`workspace container ensured for agent ${this.scope.agentId}`);
    }

    const approvalGate = new ApprovalGate();
    const approvedCache = new Set<string>();
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
      approvedCache,
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
      resumed: Boolean(persisted),
    };

    agent.subscribe((event) => {
      this.handleAgentEvent(session, event);
    });

    this.sessions.set(spec.sessionId, session);
    await this.persistSessionIndex(session);
    if (!persisted) {
      await this.store.messages.writeSessionStarted(this.scope,effectiveSpec, {
        provider: config.model.provider,
        model: config.model.model,
      });
    }
    this.logRuntime(`session opened: ${effectiveSpec.sessionId}`);

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
    const persistedSessions = await this.store.sessions.list(this.scope);
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
      return this.store.messages.listHistoryMessages(this.scope,activeSession.spec.sessionId);
    }

    const persisted = await this.store.sessions.get(this.scope,sessionId);

    if (!persisted) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return this.store.messages.listHistoryMessages(this.scope,persisted.sessionId);
  }

  async listEpisodicEntries(sessionId: string) {
    const activeSession = this.sessions.get(sessionId);

    if (activeSession) {
      await activeSession.sideEffects;
      return this.store.messages.listEpisodicEntries(this.scope,activeSession.spec.sessionId);
    }

    const persisted = await this.store.sessions.get(this.scope,sessionId);

    if (!persisted) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }

    return this.store.messages.listEpisodicEntries(this.scope,persisted.sessionId);
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
    await this.store.sessions.waitForIdle();
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

      const chronologicalHistory = await this.store.messages.listCheckpointHistory(this.scope,
        session.spec.sessionId,
      );
      const newHistory = chronologicalHistory.slice(session.lastSummarizedHistoryCount);

      if (newHistory.length === 0) {
        return false;
      }

      const config = await this.options.security.readConfig();
      const previousWorkingMemory = await this.store.messages.getSessionWorkingMemory(this.scope,
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

      await this.store.messages.appendEpisodicEntry(this.scope,session.spec.sessionId, {
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
      this.logRuntime(`session checkpoint: ${reason}`);

      await this.updateSessionWorkingMemory(
        session,
        checkpointArtifacts.sessionWorkingMemory,
      );

      await this.updateSessionDescriptionFromSummary(session, summary, config);

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

    await this.store.messages.setSessionWorkingMemory(this.scope,
      session.spec.sessionId,
      `${nextWorkingMemory.trim()}\n`,
      new Date().toISOString(),
    );
    this.logRuntime(`memory updated: session/${session.spec.sessionId}`);
  }

  private async updateSessionDescriptionFromSummary(
    session: RunnerSession,
    summary: string,
    config: AgentConfig,
  ): Promise<void> {
    try {
      const description = await this.generateSessionDescriptionFromSummary({
        sessionId: session.spec.sessionId,
        summary,
        config,
      });

      if (description) {
        session.description = description;
        session.descriptionSource = 'ai';
        await this.persistSessionIndex(session);
      }
    } catch {
      // Description update is best-effort; do not fail the checkpoint.
    }
  }

  private async generateSessionDescriptionFromSummary(input: {
    sessionId: string;
    summary: string;
    config: AgentConfig;
  }): Promise<string | undefined> {
    if (this.options.sessionDescriptionGenerator) {
      return normalizeGeneratedDescription(
        await this.options.sessionDescriptionGenerator({
          sessionId: input.sessionId,
          userText: input.summary,
          config: input.config,
        }),
      );
    }

    if (this.options.streamFn) {
      return undefined;
    }

    const apiKey = this.resolveApiKey(input.config.model.provider);

    if (!apiKey) {
      return undefined;
    }

    const response = await completeWithLangfuseTrace(
      this.options.langfuse,
      resolveModel(input.config),
      {
        systemPrompt: [
          'Generate a short session title for retrieval.',
          'Return plain text only.',
          'Do not use quotes, markdown, or trailing punctuation.',
          'Keep it under 10 words.',
          'Focus on the main topic or task, not greetings.',
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Session summary:\n${input.summary}`,
              },
            ],
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey },
      {
        name: 'openhermit.session_description',
        sessionId: input.sessionId,
        agentSessionId: input.sessionId,
        metadata: {
          requestKind: 'session-description',
        },
      },
    );

    return normalizeGeneratedDescription(extractAssistantText(response));
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
      await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
        await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
        await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
      await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
      await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
    approvedCache?: Set<string>,
  ): Promise<Agent> {
    return this.createConfiguredAgent({
      config,
      agentSessionId: spec.sessionId,
      contextSessionId: spec.sessionId,
      ...(spec.source.interactive && approvalCallback ? { approvalCallback } : {}),
      ...(onToolRequested ? { onToolRequested } : {}),
      ...(onToolStarted ? { onToolStarted } : {}),
      ...(approvedCache ? { approvedCache } : {}),
    });
  }

  private async createConfiguredAgent(input: {
    config: AgentConfig;
    agentSessionId: string;
    contextSessionId: string;
    approvalCallback?: ApprovalCallback;
    approvedCache?: Set<string>;
    onToolRequested?: ToolRequestedCallback;
    onToolStarted?: ToolStartedCallback;
    extraSystemPrompt?: string;
    tools?: ReturnType<typeof createBuiltInTools>;
    langfuseRequest?: {
      name: string;
      metadata?: Record<string, unknown>;
    };
  }): Promise<Agent> {
    const webProvider = this.resolveWebProvider(input.config);

    const tools =
      input.tools
      ?? createBuiltInTools({
        security: this.options.security,
        containerManager: this.containerManager,
        memoryProvider: this.store.memories,
        webProvider,
        instructionStore: this.store.instructions,
        storeScope: this.scope,
        ...(input.config.workspace_container ? {
          agentId: this.scope.agentId,
          workspaceContainerConfig: input.config.workspace_container,
          onExec: () => this.resetWorkspaceIdleTimer(input.config.workspace_container!),
        } : {}),
        ...(input.approvalCallback ? { approvalCallback: input.approvalCallback } : {}),
        ...(input.approvedCache ? { approvedCache: input.approvedCache } : {}),
        ...(input.onToolRequested ? { onToolRequested: input.onToolRequested } : {}),
        ...(input.onToolStarted ? { onToolStarted: input.onToolStarted } : {}),
      });
    const baseSystemPrompt = await buildSystemPrompt(
      input.config,
      this.options.security,
      {
        instructionStore: this.store.instructions,
        storeScope: this.scope,
      },
    );
    const systemPrompt = input.extraSystemPrompt
      ? `${baseSystemPrompt}\n\n${input.extraSystemPrompt}`.trim()
      : baseSystemPrompt;
    const streamFn = createLangfuseTracedStreamFn(
      this.options.langfuse,
      this.options.streamFn,
      {
        name: input.langfuseRequest?.name ?? 'openhermit.llm_step',
        sessionId: input.contextSessionId,
        agentSessionId: input.agentSessionId,
        metadata: {
          requestKind: 'llm-step',
          ...(input.langfuseRequest?.metadata ?? {}),
        },
      },
    );

    return new Agent({
      initialState: {
        systemPrompt,
        model: resolveModel(input.config),
        tools,
        thinkingLevel: 'off',
      },
      sessionId: input.agentSessionId,
      ...(streamFn ? { streamFn } : {}),
      getApiKey: (provider) => this.resolveApiKey(provider),
      transformContext: (messages, signal) =>
        this.transformContext(input.contextSessionId, messages, signal),
      transport: 'sse',
    });
  }

  private async refreshAgentConfiguration(session: RunnerSession): Promise<void> {
    await this.options.security.load();
    const config = await this.options.security.readConfig();
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

  private static formatSessionEntry(entry: import('@openhermit/store').SessionLogEntry): string | undefined {
    if (entry.role === 'user' && typeof entry.content === 'string') {
      return `[USER] ${entry.content}`;
    }

    if (entry.role === 'assistant' && typeof entry.content === 'string') {
      return `[ASSISTANT] ${entry.content}`;
    }

    if (entry.role === 'tool_call') {
      const name = typeof entry.name === 'string' ? entry.name : 'unknown';
      const args = entry.args !== undefined ? JSON.stringify(entry.args) : '';
      return `[TOOL_CALL] ${name}(${args})`;
    }

    if (entry.role === 'tool_result') {
      const name = typeof entry.name === 'string' ? entry.name : 'unknown';
      const isError = entry.isError === true;
      const content = typeof entry.content === 'string'
        ? entry.content
        : JSON.stringify(entry.content ?? '');
      const prefix = isError ? '[TOOL_ERROR]' : '[TOOL_RESULT]';
      return `${prefix} ${name}: ${content}`;
    }

    if (entry.role === 'error' && typeof entry.message === 'string') {
      return `[ERROR] ${entry.message}`;
    }

    return undefined;
  }

  /** Max share of the context window the resumption block may occupy. */
  private static readonly RESUMPTION_BUDGET_RATIO = 0.5;

  private async buildSessionResumptionBlock(
    sessionId: string,
    config: AgentConfig,
  ): Promise<AgentMessage | undefined> {
    const parts: string[] = [];

    // Load all session entries since the last compaction (or from beginning).
    const { compactionSummary, entries } =
      await this.store.messages.listSessionEntriesSinceLastCompaction(this.scope, sessionId);

    if (compactionSummary?.trim()) {
      parts.push('Previous session summary:', compactionSummary.trim(), '');
    }

    // Episodic checkpoint summaries.
    const episodicEntries = await this.store.messages.listEpisodicEntries(this.scope, sessionId);
    const checkpointSummaries = episodicEntries
      .map((entry) => entry.data.summary)
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.replace(/\s+/g, ' ').trim());

    if (checkpointSummaries.length > 0) {
      parts.push(
        'Episodic checkpoints:',
        ...checkpointSummaries.map((s) => `- ${s}`),
        '',
      );
    }

    // Format all entries, then trim oldest to fit the token budget.
    const formattedEntries = entries
      .map((entry) => AgentRunner.formatSessionEntry(entry))
      .filter((line): line is string => line !== undefined);

    if (formattedEntries.length > 0) {
      const model = resolveModel(config);
      const budgetTokens = Math.floor(model.contextWindow * AgentRunner.RESUMPTION_BUDGET_RATIO);
      const headerTokens = estimateTextTokens(parts.join('\n'));

      // Drop oldest entries until we fit the budget.
      let startIndex = 0;
      let totalTokens = headerTokens + formattedEntries.reduce(
        (sum, line) => sum + estimateTextTokens(line), 0,
      );

      while (totalTokens > budgetTokens && startIndex < formattedEntries.length - 1) {
        totalTokens -= estimateTextTokens(formattedEntries[startIndex]!);
        startIndex++;
      }

      const trimmedEntries = formattedEntries.slice(startIndex);

      if (startIndex > 0) {
        this.logDebug(
          `[${sessionId}] resumption trimmed ${startIndex}/${formattedEntries.length} oldest entries `
          + `to fit ${budgetTokens.toLocaleString()} token budget (${model.contextWindow.toLocaleString()} × ${AgentRunner.RESUMPTION_BUDGET_RATIO})`,
        );
      }

      parts.push(
        'Conversation history since last compaction (including tool interactions):',
        ...trimmedEntries,
        '',
      );
    }

    if (parts.length === 0) {
      return undefined;
    }

    return {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Session resumption context (runtime-generated, read-only context):\n\n${parts.join('\n').trim()}`,
        },
      ],
      timestamp: Date.now(),
    };
  }

  private async transformContext(
    sessionId: string,
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const config = await this.options.security.readConfig();
    const sessionWorking =
      (await this.store.messages.getSessionWorkingMemory(this.scope, sessionId)) ?? '';
    const memoryContext =
      (await this.store.memories.getContextBlock(this.scope, {
        limit: config.memory.context_entry_limit,
      })) ?? '';

    const contextBlocks: AgentMessage[] = [];

    // When a resumed session has at most 1 message in the current agent
    // instance, inject prior session context so the LLM has history.
    const session = this.sessions.get(sessionId);
    if (session?.resumed && messages.length <= 1) {
      const resumptionBlock = await this.buildSessionResumptionBlock(sessionId, config);
      if (resumptionBlock) {
        contextBlocks.push(resumptionBlock);
        session.resumed = false; // Only inject once.
      }
    }

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

    if (memoryContext.trim()) {
      contextBlocks.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Long-term memory (read-only context):\n\n${memoryContext}`,
          },
        ],
        timestamp: Date.now(),
      });
    }

    // Truncate oversized tool results before compaction so that a single
    // huge tool response cannot blow past the entire context window.
    const model = resolveModel(config);
    const truncatedMessages = truncateToolResults(messages, model.contextWindow);

    // Only offer LLM compaction when we have a dedicated API key.
    // When streamFn is provided (tests, proxied setups), the shared stream
    // should not be consumed by an internal compaction turn.
    const canRunLlmCompaction =
      !this.options.streamFn && Boolean(this.resolveApiKey(config.model.provider));

    const finalMessages = await compactContextIfNeeded(sessionId, config, contextBlocks, truncatedMessages, {
      store: this.store,
      scope: this.scope,
      options: {
        contextCompactionMaxTokens: this.options.contextCompactionMaxTokens,
        contextCompactionRecentMessageCount: this.options.contextCompactionRecentMessageCount,
        contextCompactionSummaryMaxChars: this.options.contextCompactionSummaryMaxChars,
      },
      createCompactionAgent: canRunLlmCompaction
        ? (sid) => this.createCompactionAgent(sid, config)
        : undefined,
      logRuntime: (msg) => this.logRuntime(msg),
    });

    if (AgentRunner.DEBUG) {
      const budget = getContextCompactionMaxTokens(config, {
        contextCompactionMaxTokens: this.options.contextCompactionMaxTokens,
      });
      const totalTokens = estimateAgentMessagesTokens(finalMessages);
      const contextTokens = estimateAgentMessagesTokens(contextBlocks);
      const messageTokens = estimateAgentMessagesTokens(messages);
      const pct = ((totalTokens / model.contextWindow) * 100).toFixed(1);

      const roleCounts = finalMessages.reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {});

      this.logDebug(
        `[${sessionId}] model: ${config.model.provider}/${config.model.model} | `
        + `context: ${totalTokens.toLocaleString()}/${model.contextWindow.toLocaleString()} tokens (${pct}%) | `
        + `budget: ${budget.toLocaleString()} | ctx blocks: ${contextTokens.toLocaleString()} | msgs: ${messageTokens.toLocaleString()} | `
        + `final: ${finalMessages.length} (${Object.entries(roleCounts).map(([r, c]) => `${r}:${c}`).join(' ')})`,
      );
    }

    return finalMessages;
  }

  private async createCompactionAgent(sessionId: string, config: AgentConfig): Promise<Agent> {
    return this.createConfiguredAgent({
      config,
      agentSessionId: `${sessionId}:compaction`,
      contextSessionId: sessionId,
      langfuseRequest: {
        name: 'openhermit.context_compaction',
        metadata: { requestKind: 'context-compaction' },
      },
      extraSystemPrompt: [
        'Internal compaction turn:',
        '- This is an internal runtime turn, not a user-facing reply.',
        '- Summarize the compacted conversation below into a coherent narrative.',
        '- Capture: key topics discussed, decisions made, important file paths or data, outstanding tasks or questions.',
        '- Be concise but preserve important context that will help the agent continue the conversation.',
        '- Return JSON only with key "compactionSummary".',
        '- Do not call tools.',
        '- Do not wrap the JSON in markdown fences.',
      ].join('\n'),
      tools: [],
    });
  }

  private resolveWebProvider(config: AgentConfig): WebProvider | undefined {
    const providerName = config.web?.provider ?? 'defuddle';

    if (providerName === 'defuddle') {
      return createWebProvider('defuddle');
    }

    const apiKey = this.resolveApiKey(providerName);
    if (!apiKey) {
      this.logRuntime(`web provider "${providerName}" skipped: no API key found`);
      return undefined;
    }

    return createWebProvider(providerName, apiKey);
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
          await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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

        // Handle error responses from the model provider.
        if (assistantMessage.stopReason === 'error') {
          const errorMsg = assistantMessage.errorMessage ?? 'Model returned an error.';
          const ts = new Date().toISOString();
          session.updatedAt = ts;
          void this.persistSessionIndex(session);

          this.logRuntime(`model error in ${session.spec.sessionId}: ${errorMsg}`);

          void this.events.publish({
            type: 'error',
            sessionId: session.spec.sessionId,
            message: errorMsg,
          });

          void this.queueSideEffect(session, async () => {
            await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
              ts,
              role: 'assistant',
              content: assistantText ?? '',
              provider: assistantMessage.provider,
              model: assistantMessage.model,
              usage: assistantMessage.usage,
              stopReason: 'error',
              errorMessage: errorMsg,
            });
          });
          break;
        }

        if (!assistantText || !hasMeaningfulAssistantText(assistantText)) {
          break;
        }

        session.latestAssistantText = assistantText;
        const ts = new Date().toISOString();
        session.updatedAt = ts;
        session.messageCount += 1;
        session.lastMessagePreview = assistantText;
        void this.persistSessionIndex(session);

        void this.queueSideEffect(session, async () => {
          await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
            ts,
            role: 'assistant',
            content: assistantText,
            provider: assistantMessage.provider,
            model: assistantMessage.model,
            usage: assistantMessage.usage,
            stopReason: assistantMessage.stopReason,
          });
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
          await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
        session.completedTurnCount += 1;
        session.updatedAt = ts;
        session.status = 'idle';
        void this.persistSessionIndex(session);
        this.scheduleIdleSummary(session);
        void this.queueBackgroundTask(session, async () => {
          const config = await this.options.security.readConfig();

          if (
            session.completedTurnCount - session.lastSummarizedTurnCount >=
            this.getCheckpointTurnInterval(config)
          ) {
            await this.runSessionCheckpoint(session, 'turn_limit');
          }

          if (lastUserMessageText) {
            await this.maybeGenerateSessionDescription(session, {
              userText: lastUserMessageText,
              ...(finalText ? { assistantText: finalText } : {}),
            });
          }
        });

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
          await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
            ts,
            role: 'system',
            type: 'agent_end',
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
        await this.store.messages.appendLogEntry(this.scope,session.spec.sessionId, {
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
    await this.store.sessions.upsert(this.scope,createPersistedSessionIndexEntry(session));
  }

  async listSessionLogEntries(sessionId: string) {
    const activeSession = this.sessions.get(sessionId);
    if (activeSession) {
      await activeSession.sideEffects.catch(() => undefined);
    }
    return this.store.messages.listSessionEntries(this.scope,sessionId);
  }

  private static readonly SESSION_DESCRIPTION_MIN_TURNS = 3;

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

    // Defer AI description until enough turns have accumulated for meaningful context.
    if (session.completedTurnCount < AgentRunner.SESSION_DESCRIPTION_MIN_TURNS) {
      return;
    }

    const config = await this.options.security.readConfig();
    const description = await this.generateSessionDescription({
      sessionId: session.spec.sessionId,
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
    sessionId: string;
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

    const response = await completeWithLangfuseTrace(
      this.options.langfuse,
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
      {
        name: 'openhermit.session_description',
        sessionId: input.sessionId,
        agentSessionId: input.sessionId,
        metadata: {
          requestKind: 'session-description',
        },
      },
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
      langfuseRequest: {
        name: 'openhermit.session_checkpoint',
        metadata: {
          requestKind: 'session-checkpoint',
          checkpointReason: input.reason,
        },
      },
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
