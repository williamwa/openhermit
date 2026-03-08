import {
  agentLocalRoutes,
  type SessionMessage,
  type SessionSpec,
  type ToolApprovalRequest,
} from '@cloudmind/protocol';
import {
  CloudMindError,
  type CloudMindStatusCode,
  joinUrl,
} from '@cloudmind/shared';

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

  buildEventsUrl(sessionId: string): string {
    return joinUrl(this.options.baseUrl, agentLocalRoutes.eventsUrl(sessionId));
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
      const statusCode: CloudMindStatusCode =
        response.status === 400 ||
        response.status === 401 ||
        response.status === 404 ||
        response.status === 500
          ? response.status
          : 500;

      throw new CloudMindError(
        `Agent local API request failed (${response.status}): ${responseText || response.statusText}`,
        'agent_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }
}
