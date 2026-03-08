import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
} from '@mariozechner/pi-agent-core';
import {
  getModel,
  type AssistantMessage,
  type Message,
  type Model,
} from '@mariozechner/pi-ai';
import type { SessionMessage, SessionSpec } from '@cloudmind/protocol';
import { NotFoundError, ValidationError, getErrorMessage } from '@cloudmind/shared';

import {
  AgentSecurity,
  AgentWorkspace,
  DockerContainerManager,
  type AgentConfig,
} from './core/index.js';
import { SessionLogWriter, createSessionLogPaths } from './session-logs.js';
import { type SessionDescriptor, SessionEventBroker, type SessionRuntime } from './runtime.js';
import { createBuiltInTools } from './tools.js';

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
}

export interface AgentRunnerOptions {
  workspace: AgentWorkspace;
  security: AgentSecurity;
  containerManager?: DockerContainerManager;
  streamFn?: StreamFn;
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

  private readonly logWriter: SessionLogWriter;

  private readonly sessions = new Map<string, RunnerSession>();

  private constructor(private readonly options: AgentRunnerOptions) {
    this.containerManager =
      options.containerManager ?? new DockerContainerManager(options.workspace);
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

      return {
        spec: existing.spec,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
      };
    }

    const config = await this.options.workspace.readConfig();
    const agent = await this.createAgent(spec, config);
    const paths = createSessionLogPaths(spec.sessionId, now);
    const session: RunnerSession = {
      spec,
      createdAt: now,
      updatedAt: now,
      agent,
      queue: Promise.resolve(),
      sideEffects: Promise.resolve(),
      sessionLogRelativePath: paths.sessionLogRelativePath,
      episodicRelativePath: paths.episodicRelativePath,
      latestAssistantText: undefined,
    };

    agent.subscribe((event) => {
      this.handleAgentEvent(session, event);
    });

    this.sessions.set(spec.sessionId, session);
    await this.logWriter.writeSessionStarted(paths, spec, {
      provider: config.model.provider,
      model: config.model.model,
    });

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

  getSessionLogRelativePath(sessionId: string): string {
    const session = this.getRequiredSession(sessionId);
    return session.sessionLogRelativePath;
  }

  getEpisodicLogRelativePath(sessionId: string): string {
    const session = this.getRequiredSession(sessionId);
    return session.episodicRelativePath;
  }

  async waitForSessionIdle(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    await session.queue;
    await session.sideEffects;
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }> {
    const session = this.getRequiredSession(sessionId);
    session.updatedAt = new Date().toISOString();

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

  private async createAgent(
    spec: SessionSpec,
    config: AgentConfig,
  ): Promise<Agent> {
    const tools = createBuiltInTools({
      workspace: this.options.workspace,
      security: this.options.security,
      containerManager: this.containerManager,
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
    session.agent.setTools(
      createBuiltInTools({
        workspace: this.options.workspace,
        security: this.options.security,
        containerManager: this.containerManager,
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

    return [
      'You are a pragmatic autonomous coding agent operating inside a dedicated workspace.',
      `Autonomy level: ${this.options.security.getAutonomyLevel()}.`,
      'Stay within the workspace boundaries and use tools for file and container access.',
      'Identity context:',
      identitySections,
      secretNames.length > 0
        ? `Available secret names for tool calls: ${secretNames.join(', ')}. Secret values are never shown in the prompt.`
        : 'No secret names are currently configured.',
    ].join('\n\n');
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
        const ts = new Date().toISOString();

        void this.events.publish({
          type: 'tool_start',
          sessionId: session.spec.sessionId,
          tool: event.toolName,
        });
        void this.queueSideEffect(session, async () => {
          await Promise.all([
            this.logWriter.appendSession(session.sessionLogRelativePath, {
              ts,
              role: 'tool_call',
              name: event.toolName,
              args: event.args,
              toolCallId: event.toolCallId,
            }),
            this.logWriter.appendEpisodic(session.episodicRelativePath, {
              ts,
              session: session.spec.sessionId,
              type: 'tool_called',
              data: {
                tool: event.toolName,
                args: event.args,
                toolCallId: event.toolCallId,
              },
            }),
          ]);
        });
        break;
      }

      case 'tool_execution_end': {
        const ts = new Date().toISOString();

        if (event.isError) {
          void this.events.publish({
            type: 'error',
            sessionId: session.spec.sessionId,
            message: `Tool ${event.toolName} failed.`,
          });
        }

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

        if (finalText) {
          void this.events.publish({
            type: 'text_final',
            sessionId: session.spec.sessionId,
            text: finalText,
          });
        }

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

    try {
      await Promise.all([
        this.events.publish({
          type: 'error',
          sessionId: session.spec.sessionId,
          message,
        }),
        this.queueSideEffect(session, async () => {
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
        }),
      ]);
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
}
