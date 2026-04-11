import {
  agentLocalRoutes,
  gatewayRoutes,
  type AgentInfo,
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

  private buildFetchFailedError(path: string, error: unknown): OpenHermitError {
    const message = error instanceof Error ? error.message : String(error);

    return new OpenHermitError(
      `Agent local API is unavailable at ${joinUrl(this.options.baseUrl, path)}. `
      + `Make sure the agent is running and runtime.json is current. `
      + `If you are developing locally, start it with \`npm run dev:agent\`. `
      + `Underlying error: ${message}`,
      'agent_api_error',
      500,
    );
  }

  private async getJson<T>(path: string): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.options.token}`,
        },
      });
    } catch (error) {
      throw this.buildFetchFailedError(path, error);
    }

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
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.options.baseUrl, path), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw this.buildFetchFailedError(path, error);
    }

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

// ---------------------------------------------------------------------------
// GatewayClient — talks to the multi-agent gateway
// ---------------------------------------------------------------------------

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  fetch?: FetchLike;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async listAgents(): Promise<AgentInfo[]> {
    return this.getJson(gatewayRoutes.agents);
  }

  async manageAgent(
    agentId: string,
    action: 'start' | 'stop' | 'restart',
  ): Promise<AgentInfo> {
    return this.postJson(gatewayRoutes.agentManage(agentId, action), {});
  }

  async agentHealth(agentId: string): Promise<{ agentId: string; ok: boolean; status: string }> {
    return this.getJson(gatewayRoutes.agentHealth(agentId));
  }

  /**
   * Returns an `AgentLocalClient` whose requests are routed through the
   * gateway at `/agents/:agentId/...`. The agent-local client sees the
   * same API surface as if it were talking to the agent directly.
   */
  agent(agentId: string): AgentLocalClient {
    return new AgentLocalClient({
      baseUrl: joinUrl(this.baseUrl, `/agents/${encodeURIComponent(agentId)}`),
      token: this.token,
      fetch: this.fetchImpl,
    });
  }

  private async getJson<T>(path: string): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'GET',
        headers: { authorization: `Bearer ${this.token}` },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

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
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new OpenHermitError(
        `Gateway API is unavailable at ${joinUrl(this.baseUrl, path)}: ${message}`,
        'gateway_api_error',
        500,
      );
    }

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
        `Gateway API request failed (${response.status}): ${responseText || response.statusText}`,
        'gateway_api_error',
        statusCode,
      );
    }

    return (await response.json()) as T;
  }
}
