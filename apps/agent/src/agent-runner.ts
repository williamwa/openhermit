import { userInfo } from 'node:os';

import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import type { MessageSender, SessionHistoryMessage, SessionListQuery, SessionMessage, SessionSpec, SessionSummary } from '@openhermit/protocol';
import { NotFoundError, ValidationError, getErrorMessage } from '@openhermit/shared';
import {
  type InternalStateStore,
  type StoreScope,
  type UserRole,
  DbInternalStateStore,
} from '@openhermit/store';

import {
  AgentSecurity,
  AgentWorkspace,
  DEFAULT_INTROSPECTION_CONFIG,
  DockerContainerManager,
  ExecBackendManager,
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
} from './session-utils.js';
import {
  createLangfuseTracedStreamFn,
  endTurnTrace,
  type LangfuseTurnContext,
  startTurnTrace,
} from './langfuse.js';
import { type SessionDescriptor, SessionEventBroker, type SessionRuntime } from './runtime.js';
export type { SessionEventEnvelope } from './runtime.js';
import {
  type ApprovalCallback,
  type ApprovalDecision,
  type Toolset,
  type ToolRequestedCallback,
  type ToolStartedCallback,
  createBuiltInToolsets,
  toolsFromToolsets,
} from './tools.js';
import {
  compactContextIfNeeded,
  estimateAgentMessagesTokens,
  estimateTextTokens,
  getContextCompactionMaxTokens,
  truncateToolResults,
} from './agent-runner/context-compaction.js';
import { createWebProvider, type WebProvider } from './web/index.js';
import { runIntrospection } from './introspection/index.js';

const addUserIdToList = (existing: string[], userId: string | undefined): string[] => {
  if (!userId) return existing;
  return existing.includes(userId) ? existing : [...existing, userId];
};

export class AgentRunner implements SessionRuntime {
  readonly events = new SessionEventBroker();
  readonly security: import('./core/index.js').AgentSecurity;

  private readonly containerManager: DockerContainerManager;

  private execBackendManager: ExecBackendManager | undefined;

  private readonly store: InternalStateStore;

  private readonly scope: StoreScope;

  private readonly sessions = new Map<string, RunnerSession>();

  private workspaceIdleTimer: ReturnType<typeof setTimeout> | undefined;

  private static DEBUG = false;

  private logRuntime(message: string): void {
    console.log(`[openhermit-agent] [${this.scope.agentId}] ${message}`);
  }

  private logDebug(message: string): void {
    if (AgentRunner.DEBUG) {
      console.log(`[openhermit-debug] ${message}`);
    }
  }

  private constructor(
    private readonly options: AgentRunnerOptions,
    store: InternalStateStore,
  ) {
    this.store = store;
    this.security = options.security;
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
    const store = options.store
      ?? await DbInternalStateStore.open();
    return new AgentRunner(options, store);
  }

  private getOrCreateExecBackendManager(config: AgentConfig): ExecBackendManager {
    if (!this.execBackendManager) {
      this.execBackendManager = ExecBackendManager.fromConfig(
        config.exec,
        {
          containerManager: this.containerManager,
          agentId: this.scope.agentId,
          workspaceDir: this.options.workspace.root,
        },
      );
    }
    return this.execBackendManager;
  }

  resetWorkspaceIdleTimer(lifecycle: import('./core/types.js').WorkspaceContainerLifecycle | undefined): void {
    if (this.workspaceIdleTimer) {
      clearTimeout(this.workspaceIdleTimer);
      this.workspaceIdleTimer = undefined;
    }

    const stopPolicy = lifecycle?.stop ?? 'idle';

    if (stopPolicy !== 'idle') {
      return;
    }

    const timeoutMs = (lifecycle?.idle_timeout_minutes ?? 30) * 60_000;

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
      (config.exec?.lifecycle?.stop ?? 'idle') === 'session'
    ) {
      if (this.execBackendManager) {
        await this.execBackendManager.shutdownAll();
        this.logRuntime('exec backends shut down (session end)');
      } else {
        await this.containerManager.stopWorkspaceContainer(this.scope.agentId);
        this.logRuntime('workspace container stopped (session end)');
      }
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

      // Re-resolve user identity every time the session opens.
      // This picks up merges (e.g. guest merged into owner) that happened
      // since the session was first created.
      await this.ensureOwnerBootstrap(existing.spec, now);
      const { userId, role, userName } = await this.resolveSessionUser(existing.spec, now);

      // Access control: only allow reopen if the resolved user is already
      // a participant or is the owner.  Don't silently add strangers.
      if (userId && !existing.userIds.includes(userId) && role !== 'owner') {
        throw new NotFoundError(`Session not found: ${spec.sessionId}`);
      }

      if (userId) existing.resolvedUserId = userId;
      if (role) existing.resolvedUserRole = role;
      if (userName) existing.resolvedUserName = userName;
      existing.userIds = addUserIdToList(existing.userIds, userId);

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

    // Bootstrap owner on first connection from CLI or web
    await this.ensureOwnerBootstrap(effectiveSpec, now);

    // Resolve user identity for this session
    const { userId: resolvedUserId, role: resolvedUserRole, userName: resolvedUserName } =
      await this.resolveSessionUser(effectiveSpec, now);

    // Access control on reopen: non-owner users must already be participants
    if (persisted && resolvedUserId && !persisted.userIds?.includes(resolvedUserId) && resolvedUserRole !== 'owner') {
      throw new NotFoundError(`Session not found: ${spec.sessionId}`);
    }

    if (
      (config.exec?.lifecycle?.start ?? 'ondemand') === 'session'
    ) {
      const manager = this.getOrCreateExecBackendManager(config);
      await manager.getDefault().ensure();
      this.logRuntime(`exec backend ensured for agent ${this.scope.agentId}`);
    }

    const approvalGate = new ApprovalGate();
    const approvedCache = new Set<string>();
    const approvalCallback = effectiveSpec.source.interactive
      ? this.makeApprovalCallback(effectiveSpec.sessionId, approvalGate)
      : undefined;
    const langfuseTurnContext: LangfuseTurnContext | undefined =
      this.options.langfuse ? { currentTrace: undefined } : undefined;
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
      langfuseTurnContext,
      resolvedUserRole,
      resolvedUserId,
      resolvedUserName,
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
      ...(persisted?.description ? { description: persisted.description } : {}),
      ...(persisted?.descriptionSource
        ? { descriptionSource: persisted.descriptionSource }
        : {}),
      ...(persisted?.lastMessagePreview
        ? { lastMessagePreview: persisted.lastMessagePreview }
        : {}),
      resumed: Boolean(persisted),
      userIds: addUserIdToList(persisted?.userIds ?? [], resolvedUserId),
      ...(resolvedUserId ? { resolvedUserId } : {}),
      ...(resolvedUserRole ? { resolvedUserRole } : {}),
      ...(resolvedUserName ? { resolvedUserName } : {}),
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
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

  async listSessions(query: SessionListQuery = {}, callerUserId?: string): Promise<SessionSummary[]> {
    const persistedSessions = await this.store.sessions.list(
      this.scope,
      callerUserId ? { userId: callerUserId } : undefined,
    );
    const limit = query.limit;
    const summaries = buildSessionSummaries(
      persistedSessions,
      callerUserId
        ? [...this.sessions.values()].filter((s) => s.userIds.includes(callerUserId))
        : this.sessions.values(),
      query,
      (sessionId) => this.events.getBacklog(sessionId).at(-1)?.id ?? 0,
    );

    return limit !== undefined ? summaries.slice(0, limit) : summaries;
  }

  /** Verify that callerUserId is a participant of the session. Throws NotFoundError if not. */
  async verifySessionAccess(sessionId: string, callerUserId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!session.userIds.includes(callerUserId)) {
        throw new NotFoundError(`Session not found: ${sessionId}`);
      }
      return;
    }
    const persisted = await this.store.sessions.get(this.scope, sessionId);
    if (!persisted || !persisted.userIds?.includes(callerUserId)) {
      throw new NotFoundError(`Session not found: ${sessionId}`);
    }
  }

  async listSessionMessages(sessionId: string, callerUserId?: string): Promise<SessionHistoryMessage[]> {
    // Access control: if callerUserId is set, verify participation
    if (callerUserId) {
      await this.verifySessionAccess(sessionId, callerUserId);
    }

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

  private getIdleSummaryTimeoutMs(config?: AgentConfig): number {
    const introspection = config?.memory.introspection;
    if (introspection?.enabled && introspection.idle_timeout_minutes > 0) {
      return introspection.idle_timeout_minutes * 60_000;
    }
    return DEFAULT_INTROSPECTION_CONFIG.idle_timeout_minutes * 60_000;
  }

  private getCheckpointTurnInterval(config?: AgentConfig): number {
    const introspection = config?.memory.introspection;
    if (introspection?.enabled && introspection.turn_interval > 0) {
      return introspection.turn_interval;
    }
    return DEFAULT_INTROSPECTION_CONFIG.turn_interval;
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

      const lastIntrospectionEventId = await this.store.messages.getLastIntrospectionEventId(
        this.scope,
        session.spec.sessionId,
      );

      const unsummarized = await this.store.messages.listMessagesSinceEvent(
        this.scope,
        session.spec.sessionId,
        lastIntrospectionEventId,
      );

      if (unsummarized.length === 0) {
        return false;
      }

      const latestEventId = await this.store.messages.getLatestEventId(
        this.scope,
        session.spec.sessionId,
      );

      const config = await this.options.security.readConfig();
      return await this.runIntrospection(session, reason, config, latestEventId, unsummarized);
    } finally {
      session.checkpointInProgress = false;
    }
  }

  private async runIntrospection(
    session: RunnerSession,
    reason: 'manual' | 'new_session' | 'turn_limit' | 'idle',
    config: AgentConfig,
    latestEventId: number,
    newHistory: Array<{ role: 'user' | 'assistant' | 'error'; content: string; ts: string }>,
  ): Promise<boolean> {
    const previousWorkingMemory = await this.store.messages.getSessionWorkingMemory(this.scope,
      session.spec.sessionId,
    );

    const result = await runIntrospection({
      reason,
      sessionId: session.spec.sessionId,
      config,
      store: this.store,
      scope: this.scope,
      security: this.options.security,
      history: newHistory,
      previousWorkingMemory,
      currentDescription: session.description,
      createAgent: (input) => this.createConfiguredAgent(input),
      ...(this.options.langfuse ? { langfuse: this.options.langfuse } : {}),
      logRuntime: (msg) => this.logRuntime(msg),
    });

    // Update session index
    const ts = new Date().toISOString();

    // Sync description back from store if introspection updated it
    if (result.descriptionUpdated) {
      const persisted = await this.store.sessions.get(this.scope, session.spec.sessionId);
      if (persisted?.description) {
        session.description = persisted.description;
        session.descriptionSource = 'ai';
      }
    }

    await this.persistSessionIndex(session);

    this.logRuntime(`introspection: ${reason} — ${result.toolCallCount} tool calls, success=${result.success}`);

    return result.success;
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

    // Per-message sender resolution (for group sessions or any message with sender info)
    let messageUserId = session.resolvedUserId;
    if (message.sender) {
      const now = new Date().toISOString();
      const resolved = await this.resolveMessageSender(message.sender, now);
      if (resolved.userId) {
        messageUserId = resolved.userId;
        // Update session's current user so system prompt reflects the latest sender
        session.resolvedUserId = resolved.userId;
        if (resolved.role) session.resolvedUserRole = resolved.role;
        if (resolved.userName) session.resolvedUserName = resolved.userName;
        session.userIds = addUserIdToList(session.userIds, resolved.userId);
      }
    }

    await this.persistSessionIndex(session);

    const receivedAt = new Date().toISOString();
    await this.queueSideEffect(session, async () => {
      await this.store.messages.appendLogEntry(this.scope, session.spec.sessionId, {
        ts: receivedAt,
        role: 'user',
        messageId: message.messageId,
        content: message.text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(messageUserId ? { userId: messageUserId } : {}),
      });
    });

    // In group sessions, prefix the message with the sender's display name
    // so the model can distinguish who is speaking
    const isGroup = session.spec.source.type === 'group';
    const promptMessage = isGroup && message.sender?.displayName
      ? { ...message, text: `[${message.sender.displayName}] ${message.text}` }
      : message;

    const run = async (): Promise<void> => {
      try {
        await this.refreshAgentConfiguration(session);
        session.latestAssistantText = undefined;
        if (this.options.langfuse && session.langfuseTurnContext) {
          startTurnTrace(
            this.options.langfuse,
            session.langfuseTurnContext,
            session.spec.sessionId,
            session.completedTurnCount + 1,
            message.text,
          );
        }
        await session.agent.prompt(createUserMessage(promptMessage));
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

  /**
   * Bootstrap the owner user on first connection.
   * If no users exist and the session is from CLI or web, create the owner
   * and link the channel identity.
   */
  private async ensureOwnerBootstrap(spec: SessionSpec, now: string): Promise<void> {
    const kind = spec.source.kind;
    if (kind !== 'cli' && kind !== 'web') return;

    const agentUsers = await this.store.users.listByAgent(this.scope);
    if (agentUsers.length > 0) return;

    const userId = `usr-owner`;
    const channelUserId = this.deriveChannelUserId(spec);
    const name = spec.metadata?.telegram_first_name
      ? String(spec.metadata.telegram_first_name)
      : kind === 'cli' && channelUserId
        ? channelUserId
        : undefined;

    await this.store.users.upsert({
      userId,
      ...(name ? { name } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.users.assignAgent(this.scope, userId, 'owner', now);

    // Link the channel identity if we can derive one
    if (channelUserId) {
      await this.store.users.linkIdentity({
        userId,
        channel: kind,
        channelUserId,
        createdAt: now,
      });
    }

    this.logRuntime(`owner user bootstrapped: ${userId}${channelUserId ? ` (${kind}:${channelUserId})` : ''}`);
  }

  /**
   * Resolve the user for a session based on channel identity.
   * If the identity is unknown, applies auto_guest policy: creates a guest user.
   * Returns the resolved userId and role, or undefined if no identity is available.
   */
  private async resolveSessionUser(
    spec: SessionSpec,
    now: string,
  ): Promise<{ userId?: string; role?: UserRole; userName?: string }> {
    const channelUserId = this.deriveChannelUserId(spec);
    if (!channelUserId) return {};

    const channel = spec.source.platform ?? spec.source.kind;

    // Try to resolve existing identity
    const existingUserId = await this.store.users.resolve(channel, channelUserId);
    if (existingUserId) {
      const user = await this.store.users.get(existingUserId);
      const role = await this.store.users.getAgentRole(this.scope, existingUserId) ?? 'guest';
      if (user) {
        return { userId: user.userId, role, ...(user.name ? { userName: user.name } : {}) };
      }
    }

    // Unknown identity: auto-create as guest
    const guestId = `usr-${Date.now().toString(36)}`;
    const meta = spec.metadata;
    const name = meta?.telegram_first_name
      ? String(meta.telegram_first_name)
      : meta?.telegram_username
        ? String(meta.telegram_username)
        : channel === 'cli'
          ? channelUserId
          : undefined;

    await this.store.users.upsert({
      userId: guestId,
      ...(name ? { name } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.users.assignAgent(this.scope, guestId, 'guest', now);

    await this.store.users.linkIdentity({
      userId: guestId,
      channel,
      channelUserId,
      createdAt: now,
    });

    this.logRuntime(`auto-created guest user ${guestId} for ${channel}:${channelUserId}`);
    return { userId: guestId, role: 'guest' as const, ...(name ? { userName: name } : {}) };
  }

  /**
   * Resolve a per-message sender to a user identity.
   * Used in group sessions where each message may come from a different user.
   */
  private async resolveMessageSender(
    sender: MessageSender,
    now: string,
  ): Promise<{ userId?: string; role?: UserRole; userName?: string }> {
    const existingUserId = await this.store.users.resolve(
      sender.channel, sender.channelUserId,
    );
    if (existingUserId) {
      const user = await this.store.users.get(existingUserId);
      const role = await this.store.users.getAgentRole(this.scope, existingUserId) ?? 'guest';
      if (user) {
        return { userId: user.userId, role, ...(user.name ? { userName: user.name } : {}) };
      }
    }

    // Auto-create guest for unknown sender
    const guestId = `usr-${Date.now().toString(36)}`;
    await this.store.users.upsert({
      userId: guestId,
      ...(sender.displayName ? { name: sender.displayName } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await this.store.users.assignAgent(this.scope, guestId, 'guest', now);
    await this.store.users.linkIdentity({
      userId: guestId,
      channel: sender.channel,
      channelUserId: sender.channelUserId,
      createdAt: now,
    });
    this.logRuntime(`auto-created guest user ${guestId} for ${sender.channel}:${sender.channelUserId}`);
    return { userId: guestId, role: 'guest' as const, ...(sender.displayName ? { userName: sender.displayName } : {}) };
  }

  /**
   * Resolve a CallerIdentity to an internal userId (read-only, no auto-creation).
   * Used by WS handlers to scope session.list / session.history before any
   * session is opened.  Returns undefined if the identity is unknown.
   */
  async resolveCallerUserId(
    caller: { channel: string; channelUserId: string },
  ): Promise<string | undefined> {
    return this.store.users.resolve(caller.channel, caller.channelUserId);
  }

  /**
   * Derive a channel user ID from a session spec's metadata and source.
   * Returns undefined if no identity can be extracted.
   */
  private deriveChannelUserId(spec: SessionSpec): string | undefined {
    // Group sessions resolve users per-message, not per-session
    if (spec.source.type === 'group') return undefined;

    const meta = spec.metadata;

    // Telegram: prefer user_id (from.id), fall back to chat_id (equals user id in DMs)
    if (spec.source.platform === 'telegram') {
      if (meta?.telegram_user_id) return String(meta.telegram_user_id);
      if (meta?.telegram_chat_id) return String(meta.telegram_chat_id);
      if (meta?.telegram_username) return String(meta.telegram_username);
    }

    // CLI / web: use explicit metadata username or OS username as fallback
    if (meta?.username) return String(meta.username);

    if (spec.source.kind === 'cli') {
      try {
        return userInfo().username;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  private async createAgent(
    spec: SessionSpec,
    config: AgentConfig,
    approvalCallback?: ApprovalCallback,
    onToolRequested?: ToolRequestedCallback,
    onToolStarted?: ToolStartedCallback,
    approvedCache?: Set<string>,
    langfuseTurnContext?: LangfuseTurnContext,
    userRole?: UserRole,
    userId?: string,
    userName?: string,
  ): Promise<Agent> {
    return this.createConfiguredAgent({
      config,
      agentSessionId: spec.sessionId,
      contextSessionId: spec.sessionId,
      ...(spec.source.interactive && approvalCallback ? { approvalCallback } : {}),
      ...(onToolRequested ? { onToolRequested } : {}),
      ...(onToolStarted ? { onToolStarted } : {}),
      ...(approvedCache ? { approvedCache } : {}),
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
      ...(userRole ? { userRole } : {}),
      ...(userId ? { userId } : {}),
      ...(userName ? { userName } : {}),
      ...(spec.source.type ? { sessionType: spec.source.type } : {}),
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
    tools?: any[];
    langfuseTurnContext?: LangfuseTurnContext;
    userRole?: UserRole;
    userId?: string;
    userName?: string;
    sessionType?: import('@openhermit/protocol').SessionType;
  }): Promise<Agent> {
    const webProvider = this.resolveWebProvider(input.config);

    // Role-based tool filtering:
    // - owner: all tools (memory, instructions, exec, containers, web, sessions, user management)
    // - user: memory, exec, containers, web, sessions (no instructions, no user management)
    // - guest (with userId): web, sessions (filtered by userId)
    // - undefined (no user resolved): web only (no sessions — can't identify caller)
    const role = input.userRole;
    const isOwnerOrUnresolved = role === 'owner';
    const isGuestRole = !role || role === 'guest';

    // When tools are provided directly (introspection, compaction), skip toolset creation
    let toolsets: Toolset[];
    let tools: any[];
    if (input.tools) {
      toolsets = [];
      tools = input.tools;
    } else {
      toolsets = createBuiltInToolsets({
        security: this.options.security,
        containerManager: this.containerManager,
        ...(!isGuestRole ? { memoryProvider: this.store.memories } : {}),
        messageStore: this.store.messages,
        sessionId: input.contextSessionId,
        webProvider,
        ...(isOwnerOrUnresolved ? { instructionStore: this.store.instructions } : {}),
        ...(isOwnerOrUnresolved ? { userStore: this.store.users } : {}),
        ...(isOwnerOrUnresolved || input.userId ? { sessionStore: this.store.sessions } : {}),
        ...(!isOwnerOrUnresolved && input.userId ? { currentUserId: input.userId } : {}),
        storeScope: this.scope,
        ...(!isGuestRole ? {
          agentId: this.scope.agentId,
          execBackendManager: this.getOrCreateExecBackendManager(input.config),
          onExec: () => this.resetWorkspaceIdleTimer(input.config.exec?.lifecycle),
        } : {}),
        ...(input.approvalCallback ? { approvalCallback: input.approvalCallback } : {}),
        ...(input.approvedCache ? { approvedCache: input.approvedCache } : {}),
        ...(input.onToolRequested ? { onToolRequested: input.onToolRequested } : {}),
        ...(input.onToolStarted ? { onToolStarted: input.onToolStarted } : {}),
      });
      tools = toolsFromToolsets(toolsets);
    }

    // Guest role: strip exec and container tools
    const GUEST_BLOCKED_TOOLS = new Set([
      'exec', 'container_run', 'container_start', 'container_stop', 'container_exec', 'container_status',
    ]);
    const filteredTools = isGuestRole
      ? tools.filter((t: any) => !GUEST_BLOCKED_TOOLS.has(t.name))
      : tools;

    const currentUser = input.userId && input.userRole
      ? {
          userId: input.userId,
          role: input.userRole,
          ...(input.userName ? { name: input.userName } : {}),
          ...(input.sessionType ? { sessionType: input.sessionType } : {}),
        }
      : undefined;
    const baseSystemPrompt = await buildSystemPrompt(
      input.config,
      this.options.security,
      toolsets,
      {
        instructionStore: this.store.instructions,
        storeScope: this.scope,
      },
      currentUser,
    );
    const systemPrompt = input.extraSystemPrompt
      ? `${baseSystemPrompt}\n\n${input.extraSystemPrompt}`.trim()
      : baseSystemPrompt;
    const streamFn = createLangfuseTracedStreamFn(
      this.options.langfuse,
      this.options.streamFn,
      input.langfuseTurnContext ?? { currentTrace: undefined },
    );

    return new Agent({
      initialState: {
        systemPrompt,
        model: resolveModel(input.config),
        tools: filteredTools,
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
      ...(session.resolvedUserRole ? { userRole: session.resolvedUserRole } : {}),
      ...(session.resolvedUserId ? { userId: session.resolvedUserId } : {}),
      ...(session.resolvedUserName ? { userName: session.resolvedUserName } : {}),
      ...(session.spec.source.type ? { sessionType: session.spec.source.type } : {}),
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

    if (entry.role === 'system' && entry.type === 'introspection_start') {
      const reason = typeof entry.reason === 'string' ? entry.reason : '';
      return `[INTROSPECTION_START] reason: ${reason}`;
    }

    if (entry.role === 'system' && entry.type === 'introspection_end') {
      const summary = typeof entry.summary === 'string' ? entry.summary : '';
      return `[INTROSPECTION_END] ${summary}`;
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
    const langfuseTurnContext: LangfuseTurnContext | undefined = this.options.langfuse
      ? {
          currentTrace: this.options.langfuse.trace({
            name: 'openhermit.compaction',
            sessionId,
          }),
        }
      : undefined;

    return this.createConfiguredAgent({
      config,
      agentSessionId: `${sessionId}:compaction`,
      contextSessionId: sessionId,
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
      ...(langfuseTurnContext ? { langfuseTurnContext } : {}),
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

          const turnsSinceLast = await this.store.messages.getTurnsSinceLastIntrospection(
            this.scope,
            session.spec.sessionId,
          );
          if (turnsSinceLast >= this.getCheckpointTurnInterval(config)) {
            await this.runSessionCheckpoint(session, 'turn_limit');
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

        if (this.options.langfuse && session.langfuseTurnContext) {
          void endTurnTrace(this.options.langfuse, session.langfuseTurnContext, {
            ...(finalText ? { text: finalText } : {}),
          });
        }

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

    if (this.options.langfuse && session.langfuseTurnContext) {
      void endTurnTrace(this.options.langfuse, session.langfuseTurnContext, {
        error: message,
      });
    }

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


}
