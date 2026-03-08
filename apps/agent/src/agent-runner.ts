import { promises as fs } from 'node:fs';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
} from '@mariozechner/pi-agent-core';
import {
  complete,
  getModel,
  type AssistantMessage,
  type Message,
  type Model,
} from '@mariozechner/pi-ai';
import type { SessionMessage, SessionSpec } from '@cloudmind/protocol';
import type { SessionListQuery, SessionStatus, SessionSummary } from '@cloudmind/protocol';
import { NotFoundError, ValidationError, getErrorMessage } from '@cloudmind/shared';

// ---------------------------------------------------------------------------
// ApprovalGate — per-session registry of pending tool approval Promises.
// The tool's execute() calls gate.request(), which suspends until the HTTP
// /approve endpoint resolves it via gate.respond().
// ---------------------------------------------------------------------------

const APPROVAL_TIMEOUT_MS = 120_000; // 2 minutes before auto-deny

class ApprovalGate {
  private readonly pending = new Map<
    string,
    {
      resolve: (decision: ApprovalDecision) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  /** Suspend until the user approves or denies this toolCallId. */
  request(toolCallId: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(toolCallId);
        resolve('timed_out');
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(toolCallId, { resolve, timeout });
    });
  }

  /**
   * Resolve a pending approval.
   * Returns true if a pending entry was found, false if it was already resolved
   * or never registered (e.g. the gate timed out).
   */
  respond(toolCallId: string, approved: boolean): boolean {
    const pending = this.pending.get(toolCallId);

    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(toolCallId);
    pending.resolve(approved ? 'approved' : 'rejected');
    return true;
  }

  /** Cancel all pending approvals (e.g. on session teardown). */
  cancelAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.resolve('cancelled');
    }

    this.pending.clear();
  }
}

import {
  AgentSecurity,
  AgentWorkspace,
  DockerContainerManager,
  type AgentConfig,
} from './core/index.js';
import {
  SessionIndexStore,
  SessionLogWriter,
  createSessionLogPaths,
  type PersistedSessionIndexEntry,
} from './session-logs.js';
import { type SessionDescriptor, SessionEventBroker, type SessionRuntime } from './runtime.js';
import {
  type ApprovalCallback,
  type ApprovalDecision,
  type ToolRequestedCallback,
  type ToolStartedCallback,
  createBuiltInTools,
} from './tools.js';

const SECRET_NAME_CANDIDATES: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
};

interface RunnerSession extends SessionDescriptor {
  agent: Agent;
  queue: Promise<void>;
  sideEffects: Promise<void>;
  sessionLogRelativePath: string;
  episodicRelativePath: string;
  latestAssistantText: string | undefined;
  lastUserMessageText?: string;
  approvalGate: ApprovalGate;
  status: SessionStatus;
  messageCount: number;
  description?: string;
  descriptionSource?: 'fallback' | 'ai';
  lastMessagePreview?: string;
}

export interface AgentRunnerOptions {
  workspace: AgentWorkspace;
  security: AgentSecurity;
  containerManager?: DockerContainerManager;
  streamFn?: StreamFn;
  sessionDescriptionGenerator?: (
    input: {
      userText: string;
      assistantText?: string;
      config: AgentConfig;
    },
  ) => Promise<string | undefined>;
}

const isAssistantMessage = (message: AgentMessage): message is AssistantMessage =>
  typeof message === 'object' &&
  message !== null &&
  'role' in message &&
  message.role === 'assistant';

const extractAssistantText = (message: AssistantMessage): string =>
  message.content
    .filter((content): content is Extract<typeof content, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('');

const createUserMessage = (message: SessionMessage): Message => {
  const text =
    message.attachments && message.attachments.length > 0
      ? `${message.text}\n\n[Attachments are not yet mapped into the model context. Count: ${message.attachments.length}]`
      : message.text;

  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text,
      },
    ],
    timestamp: Date.now(),
  };
};

const createProviderSecretCandidates = (provider: string): string[] => {
  const configured = SECRET_NAME_CANDIDATES[provider];

  if (configured) {
    return configured;
  }

  return [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`];
};

const formatMissingApiKeyMessage = (
  provider: string,
  secretsFilePath: string,
): string => {
  const candidateNames = createProviderSecretCandidates(provider);

  return [
    `Missing API key for provider "${provider}".`,
    `Add one of [${candidateNames.join(', ')}] to ${secretsFilePath}, or export it in the environment before starting the agent.`,
  ].join(' ');
};

const serializeDetails = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const CONTAINER_TOOL_GUIDANCE = [
  'Container tool rules:',
  '- Container tools do not see the whole workspace. They only see the mounted subdirectory.',
  '- Valid mounts must stay under containers/{name}/data.',
  '- Files under files/ or the workspace root are not mounted automatically.',
  '- Before running code in a container, write or copy the needed files into the chosen mount directory first.',
  '- For ephemeral runs, mounted files appear under /workspace inside the container.',
  '- If a container tool fails, inspect the tool result details and correct the mount or in-container path before retrying.',
].join('\n');

const RUNTIME_PROMPT_TEMPLATE_CANDIDATES = [
  new URL('./prompts/runtime-system.md', import.meta.url),
  new URL('../src/prompts/runtime-system.md', import.meta.url),
];

const replacePromptTokens = (
  template: string,
  values: Record<string, string>,
): string =>
  Object.entries(values).reduce(
    (content, [key, value]) => content.replaceAll(`{${key}}`, value),
    template,
  );

const loadRuntimePromptTemplate = async (): Promise<string> => {
  for (const candidate of RUNTIME_PROMPT_TEMPLATE_CANDIDATES) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Try the next candidate so both tsx (src) and compiled dist can work.
    }
  }

  throw new Error('Unable to load runtime system prompt template.');
};

const extractToolResultText = (result: unknown): string | undefined => {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  const content = 'content' in result ? result.content : undefined;

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts = content
    .filter(
      (entry): entry is { type: 'text'; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        'type' in entry &&
        entry.type === 'text' &&
        'text' in entry &&
        typeof entry.text === 'string',
    )
    .map((entry) => entry.text.trim())
    .filter((entry) => entry.length > 0);

  if (textParts.length === 0) {
    return undefined;
  }

  return textParts.join('\n');
};

const extractToolResultDetails = (result: unknown): unknown => {
  if (!result || typeof result !== 'object') {
    return undefined;
  }

  if (!('details' in result)) {
    return undefined;
  }

  return result.details;
};

const toSingleLine = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const createFallbackDescription = (text: string): string | undefined => {
  const normalized = toSingleLine(text);

  if (!normalized) {
    return undefined;
  }

  return normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 77)}...`;
};

const normalizeGeneratedDescription = (
  value: string | undefined,
): string | undefined => {
  if (!value) {
    return undefined;
  }

  const normalized = toSingleLine(value)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^[#*\-\s]+/, '');

  if (!normalized) {
    return undefined;
  }

  return normalized.length <= 80
    ? normalized
    : `${normalized.slice(0, 77)}...`;
};

const matchesSessionListQuery = (
  summary: SessionSummary,
  query: SessionListQuery,
): boolean => {
  if (query.kind && summary.source.kind !== query.kind) {
    return false;
  }

  if (query.platform && summary.source.platform !== query.platform) {
    return false;
  }

  if (
    query.interactive !== undefined &&
    summary.source.interactive !== query.interactive
  ) {
    return false;
  }

  return true;
};

const sortSessionSummaries = (
  left: SessionSummary,
  right: SessionSummary,
): number => right.lastActivityAt.localeCompare(left.lastActivityAt);

const resolveModel = (config: AgentConfig): Model<any> => {
  try {
    return getModel(
      config.model.provider as never,
      config.model.model as never,
    ) as Model<any>;
  } catch (error) {
    throw new ValidationError(
      `Unsupported model configuration: ${config.model.provider}/${config.model.model}`,
    );
  }
};

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
    const summaries = persistedSessions
      .map((session) => ({
        sessionId: session.sessionId,
        source: session.source,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
        lastEventId: 0,
        messageCount: session.messageCount,
        ...(session.description ? { description: session.description } : {}),
        ...(session.lastMessagePreview
          ? { lastMessagePreview: session.lastMessagePreview }
          : {}),
        status: 'idle' as const,
      }))
      .map((summary) => {
        const activeSession = this.sessions.get(summary.sessionId);

        if (!activeSession) {
          return summary;
        }

        return {
          sessionId: activeSession.spec.sessionId,
          source: activeSession.spec.source,
          createdAt: activeSession.createdAt,
          lastActivityAt: activeSession.updatedAt,
          lastEventId:
            this.events.getBacklog(activeSession.spec.sessionId).at(-1)?.id ?? 0,
          messageCount: activeSession.messageCount,
          ...(activeSession.description
            ? { description: activeSession.description }
            : {}),
          ...(activeSession.lastMessagePreview
            ? { lastMessagePreview: activeSession.lastMessagePreview }
            : {}),
          status: activeSession.status,
        };
      })
      .concat(
        [...this.sessions.values()]
          .filter(
            (session) =>
              !persistedSessions.some(
                (entry) => entry.sessionId === session.spec.sessionId,
              ),
          )
          .map((session) => ({
            sessionId: session.spec.sessionId,
            source: session.spec.source,
            createdAt: session.createdAt,
            lastActivityAt: session.updatedAt,
            lastEventId:
              this.events.getBacklog(session.spec.sessionId).at(-1)?.id ?? 0,
            messageCount: session.messageCount,
            ...(session.description ? { description: session.description } : {}),
            ...(session.lastMessagePreview
              ? { lastMessagePreview: session.lastMessagePreview }
              : {}),
            status: session.status,
          })),
      )
      .filter((summary) => matchesSessionListQuery(summary, query))
      .sort(sortSessionSummaries);

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
    const systemPrompt = await this.buildSystemPrompt(config);

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
    session.agent.setSystemPrompt(await this.buildSystemPrompt(config));

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

  private async buildSystemPrompt(config: AgentConfig): Promise<string> {
    const identityFiles = await Promise.all(
      config.identity.files.map(async (relativePath) => ({
        relativePath,
        content: await this.options.workspace.readFile(relativePath).catch(() => ''),
      })),
    );
    const identitySections = identityFiles
      .map(
        ({ relativePath, content }) =>
          `File: ${relativePath}\n${content.trim() || '(empty)'}`,
      )
      .join('\n\n');
    const secretNames = this.options.security.listSecretNames();
    const promptTemplate = await loadRuntimePromptTemplate();

    return replacePromptTokens(promptTemplate, {
      autonomyLevel: this.options.security.getAutonomyLevel(),
      containerToolGuidance: CONTAINER_TOOL_GUIDANCE,
      identitySections,
      secretReference: secretNames.length > 0
        ? `Available secret names for tool calls: ${secretNames.join(', ')}. Secret values are never shown in the prompt.`
        : 'No secret names are currently configured.',
    }).trim();
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
        session.updatedAt = ts;
        session.status = 'idle';
        void this.persistSessionIndex(session);
        void this.queueSideEffect(session, async () => {
          await this.maybeGenerateSessionDescription(session, finalText);
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
        `[cloudmind-agent] failed to surface run error for ${session.spec.sessionId}`,
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
        `[cloudmind-agent] failed to persist session side effect for ${session.spec.sessionId}`,
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
    await this.sessionIndex.upsert(
      this.createPersistedSessionIndexEntry(session),
    );
  }

  private createPersistedSessionIndexEntry(
    session: RunnerSession,
  ): PersistedSessionIndexEntry {
    return {
      sessionId: session.spec.sessionId,
      source: session.spec.source,
      createdAt: session.createdAt,
      lastActivityAt: session.updatedAt,
      messageCount: session.messageCount,
      ...(session.description ? { description: session.description } : {}),
      ...(session.descriptionSource
        ? { descriptionSource: session.descriptionSource }
        : {}),
      ...(session.lastMessagePreview
        ? { lastMessagePreview: session.lastMessagePreview }
        : {}),
      sessionLogRelativePath: session.sessionLogRelativePath,
      episodicRelativePath: session.episodicRelativePath,
      ...(session.spec.metadata ? { metadata: session.spec.metadata } : {}),
    };
  }

  private async maybeGenerateSessionDescription(
    session: RunnerSession,
    assistantText: string | undefined,
  ): Promise<void> {
    if (session.descriptionSource === 'ai' || !session.lastUserMessageText) {
      return;
    }

    const config = await this.options.workspace.readConfig();
    const description = await this.generateSessionDescription({
      userText: session.lastUserMessageText,
      config,
      ...(assistantText ? { assistantText } : {}),
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
