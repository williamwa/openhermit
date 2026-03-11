import {
  agentLocalRoutes,
  type SessionHistoryMessage,
  type SessionCheckpointRequest,
  type SessionListQuery,
  type SessionMessage,
  type SessionSummary,
  type SessionSpec,
  type ToolApprovalRequest,
} from '@openhermit/protocol';
import {
  OpenHermitError,
  type OpenHermitStatusCode,
  joinUrl,
} from '@openhermit/shared';

type FetchLike = typeof fetch;

export interface AgentLocalClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class AgentLocalClient {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: AgentLocalClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async openSession(spec: SessionSpec): Promise<{ sessionId: string }> {
    return this.postJson(agentLocalRoutes.sessions, spec);
  }

  async listSessions(query: SessionListQuery = {}): Promise<SessionSummary[]> {
    const searchParams = new URLSearchParams();

    if (query.kind) {
      searchParams.set('kind', query.kind);
    }

    if (query.platform) {
      searchParams.set('platform', query.platform);
    }

    if (query.interactive !== undefined) {
      searchParams.set('interactive', String(query.interactive));
    }

    if (query.limit !== undefined) {
      searchParams.set('limit', String(query.limit));
    }

    const path = searchParams.size > 0
      ? `${agentLocalRoutes.sessions}?${searchParams.toString()}`
      : agentLocalRoutes.sessions;

    return this.getJson(path);
  }

  async listSessionMessages(sessionId: string): Promise<SessionHistoryMessage[]> {
    return this.getJson(agentLocalRoutes.sessionMessages(sessionId));
  }

  async postMessage(
    sessionId: string,
    message: SessionMessage,
  ): Promise<{ sessionId: string; messageId?: string }> {
    return this.postJson(agentLocalRoutes.sessionMessages(sessionId), message);
  }

  async submitApproval(
    sessionId: string,
    request: ToolApprovalRequest,
  ): Promise<{ resolved: boolean }> {
    return this.postJson(agentLocalRoutes.sessionApprove(sessionId), request);
  }

  async checkpointSession(
    sessionId: string,
    request: SessionCheckpointRequest = {},
  ): Promise<{ checkpointed: boolean }> {
    return this.postJson(agentLocalRoutes.sessionCheckpoint(sessionId), request);
  }

  buildEventsUrl(sessionId: string): string {
    return joinUrl(this.options.baseUrl, agentLocalRoutes.eventsUrl(sessionId));
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    });

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Agent local API request failed (${response.status}): ${responseText || response.statusText}`,
        'agent_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const responseText = await response.text();
      const statusCode: OpenHermitStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new OpenHermitError(
        `Agent local API request failed (${response.status}): ${responseText || response.statusText}`,
        'agent_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }
}
