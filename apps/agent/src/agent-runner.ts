import { Agent, type AgentEvent, type AgentMessage } from '@mariozechner/pi-agent-core';
import { complete } from '@mariozechner/pi-ai';
import type { SessionListQuery, SessionMessage, SessionSpec, SessionSummary } from '@openhermit/protocol';
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
  extractToolResultDetails,
  extractToolResultText,
  isAssistantMessage,
  serializeDetails,
} from './agent-runner/message-utils.js';
import {
  SessionIndexStore,
  SessionLogWriter,
  createSessionLogPaths,
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

export class AgentRunner implements SessionRuntime {
  readonly events = new SessionEventBroker();

  private readonly containerManager: DockerContainerManager;

  private readonly sessionIndex: SessionIndexStore;

  private readonly logWriter: SessionLogWriter;

  private readonly sessions = new Map<string, RunnerSession>();

  private constructor(private readonly options: AgentRunnerOptions) {
    this.containerManager =
      options.containerManager ?? new DockerContainerManager(options.workspace);
    this.sessionIndex = new SessionIndexStore(options.workspace);
    this.logWriter = new SessionLogWriter(options.workspace);
  }

  static async create(options: AgentRunnerOptions): Promise<AgentRunner> {
    return new AgentRunner(options);
  }

  async openSession(spec: SessionSpec): Promise<SessionDescriptor> {
    const existing = this.sessions.get(spec.sessionId);
    const now = new Date().toISOString();

    if (existing) {
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
    const paths = persisted
      ? {
          sessionLogRelativePath: persisted.sessionLogRelativePath,
          episodicRelativePath: persisted.episodicRelativePath,
        }
      : createSessionLogPaths(effectiveSpec.sessionId, createdAt);
    session = {
      spec: effectiveSpec,
      createdAt,
      updatedAt: now,
      agent,
      queue: Promise.resolve(),
      sideEffects: Promise.resolve(),
      backgroundTasks: Promise.resolve(),
      sessionLogRelativePath: paths.sessionLogRelativePath,
      episodicRelativePath: paths.episodicRelativePath,
      latestAssistantText: undefined,
      approvalGate,
      status: 'idle',
      messageCount: persisted?.messageCount ?? 0,
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
    if (!persisted) {
      await this.logWriter.writeSessionStarted(paths, effectiveSpec, {
        provider: config.model.provider,
        model: config.model.model,
      });
    }
    await this.persistSessionIndex(session);

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

  getSessionLogRelativePath(sessionId: string): string {
    const session = this.getRequiredSession(sessionId);
    return session.sessionLogRelativePath;
  }

  getEpisodicLogRelativePath(sessionId: string): string {
    const session = this.getRequiredSession(sessionId);
    return session.episodicRelativePath;
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

  async waitForSessionIdle(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    await session.queue;
    await session.sideEffects;
    await session.backgroundTasks;
    await this.sessionIndex.waitForIdle();
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }> {
    const session = this.getRequiredSession(sessionId);
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
      await Promise.all([
        this.logWriter.appendSession(session.sessionLogRelativePath, {
          ts: receivedAt,
          role: 'user',
          messageId: message.messageId,
          content: message.text,
          ...(message.attachments ? { attachments: message.attachments } : {}),
        }),
        this.logWriter.appendEpisodic(session.episodicRelativePath, {
          ts: receivedAt,
          session: session.spec.sessionId,
          type: 'message_received',
          data: {
            role: 'user',
            content: message.text,
            ...(message.messageId ? { messageId: message.messageId } : {}),
            ...(message.attachments ? { attachments: message.attachments } : {}),
          },
        }),
      ]);
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
        await Promise.all([
          this.logWriter.appendSession(session.sessionLogRelativePath, {
            ts,
            role: 'tool_call',
            type: 'tool_started',
            name: toolName,
            args,
            toolCallId,
          }),
          this.logWriter.appendEpisodic(session.episodicRelativePath, {
            ts,
            session: session.spec.sessionId,
            type: 'tool_started',
            data: {
              tool: toolName,
              args,
              toolCallId,
            },
          }),
        ]);
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
        await Promise.all([
          this.logWriter.appendSession(session.sessionLogRelativePath, {
            ts,
            role: 'tool_call',
            type: 'tool_requested',
            name: toolName,
            args,
            toolCallId,
          }),
          this.logWriter.appendEpisodic(session.episodicRelativePath, {
            ts,
            session: session.spec.sessionId,
            type: 'tool_requested',
            data: {
              tool: toolName,
              args,
              toolCallId,
            },
          }),
        ]);
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
      await Promise.all([
        this.logWriter.appendSession(session.sessionLogRelativePath, {
          ts,
          role: 'system',
          type: 'tool_approval_requested',
          toolName,
          toolCallId,
          ...(args !== undefined ? { args } : {}),
        }),
        this.logWriter.appendEpisodic(session.episodicRelativePath, {
          ts,
          session: session.spec.sessionId,
          type: 'tool_approval_requested',
          data: {
            toolName,
            toolCallId,
            ...(args !== undefined ? { args } : {}),
          },
        }),
      ]);
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
      await Promise.all([
        this.logWriter.appendSession(session.sessionLogRelativePath, {
          ts,
          role: 'system',
          type: 'tool_approval_resolved',
          toolName,
          toolCallId,
          decision,
        }),
        this.logWriter.appendEpisodic(session.episodicRelativePath, {
          ts,
          session: session.spec.sessionId,
          type: 'tool_approval_resolved',
          data: {
            toolName,
            toolCallId,
            decision,
          },
        }),
      ]);
    });
  }

  private async createAgent(
    spec: SessionSpec,
    config: AgentConfig,
    approvalCallback?: ApprovalCallback,
    onToolRequested?: ToolRequestedCallback,
    onToolStarted?: ToolStartedCallback,
  ): Promise<Agent> {
    const tools = createBuiltInTools({
      workspace: this.options.workspace,
      security: this.options.security,
      containerManager: this.containerManager,
      ...(approvalCallback ? { approvalCallback } : {}),
      ...(onToolRequested ? { onToolRequested } : {}),
      ...(onToolStarted ? { onToolStarted } : {}),
    });
    const systemPrompt = await buildSystemPrompt(
      config,
      this.options.workspace,
      this.options.security,
    );

    return new Agent({
      initialState: {
        systemPrompt,
        model: resolveModel(config),
        tools,
        thinkingLevel: 'off',
      },
      sessionId: spec.sessionId,
      ...(this.options.streamFn ? { streamFn: this.options.streamFn } : {}),
      getApiKey: (provider) => this.resolveApiKey(provider),
      transformContext: (messages, signal) =>
        this.transformContext(messages, signal),
      transport: 'sse',
    });
  }

  private async refreshAgentConfiguration(session: RunnerSession): Promise<void> {
    await this.options.security.load();
    const config = await this.options.workspace.readConfig();
    this.ensureProviderApiKey(config.model.provider);
    session.agent.setModel(resolveModel(config));
    session.agent.setSystemPrompt(
      await buildSystemPrompt(config, this.options.workspace, this.options.security),
    );

    const approvalCallback = session.spec.source.interactive
      ? this.makeApprovalCallback(session.spec.sessionId, session.approvalGate)
      : undefined;

    session.agent.setTools(
      createBuiltInTools({
        workspace: this.options.workspace,
        security: this.options.security,
        containerManager: this.containerManager,
        ...(approvalCallback ? { approvalCallback } : {}),
        onToolRequested: this.makeToolRequestedCallback(session),
        onToolStarted: this.makeToolStartedCallback(session),
      }),
    );
    session.agent.sessionId = session.spec.sessionId;
  }

  private async transformContext(
    messages: AgentMessage[],
    _signal?: AbortSignal,
  ): Promise<AgentMessage[]> {
    const workingMemory = await this.options.workspace
      .readFile('memory/working.md')
      .catch(() => '');

    if (!workingMemory.trim()) {
      return messages;
    }

    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Working memory (read-only context):\n\n${workingMemory}`,
          },
        ],
        timestamp: Date.now(),
      },
      ...messages,
    ];
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
          await this.logWriter.appendSession(session.sessionLogRelativePath, {
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

        if (!assistantText) {
          break;
        }

        session.latestAssistantText = assistantText;
        const ts = new Date().toISOString();
        session.updatedAt = ts;
        session.messageCount += 1;
        session.lastMessagePreview = assistantText;
        void this.persistSessionIndex(session);

        void this.queueSideEffect(session, async () => {
          await Promise.all([
            this.logWriter.appendSession(session.sessionLogRelativePath, {
              ts,
              role: 'assistant',
              content: assistantText,
              provider: assistantMessage.provider,
              model: assistantMessage.model,
              usage: assistantMessage.usage,
              stopReason: assistantMessage.stopReason,
            }),
            this.logWriter.appendEpisodic(session.episodicRelativePath, {
              ts,
              session: session.spec.sessionId,
              type: 'message_sent',
              data: {
                role: 'assistant',
                content: assistantText,
                provider: assistantMessage.provider,
                model: assistantMessage.model,
                usage: assistantMessage.usage,
              },
            }),
          ]);
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
          await Promise.all([
            this.logWriter.appendSession(session.sessionLogRelativePath, {
              ts,
              role: 'tool_result',
              name: event.toolName,
              toolCallId: event.toolCallId,
              isError: event.isError,
              content: serializeDetails(event.result),
            }),
            this.logWriter.appendEpisodic(session.episodicRelativePath, {
              ts,
              session: session.spec.sessionId,
              type: 'tool_result',
              data: {
                tool: event.toolName,
                toolCallId: event.toolCallId,
                isError: event.isError,
                result: event.result,
              },
            }),
          ]);
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
          await this.logWriter.appendSession(session.sessionLogRelativePath, {
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
      await this.queueSideEffect(session, async () => {
        await Promise.all([
          this.logWriter.appendSession(session.sessionLogRelativePath, {
            ts,
            role: 'error',
            message,
          }),
          this.logWriter.appendEpisodic(session.episodicRelativePath, {
            ts,
            session: session.spec.sessionId,
            type: 'run_error',
            data: {
              message,
            },
          }),
        ]);
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
}
