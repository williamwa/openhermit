import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Type } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { McpServerRecord } from '@openhermit/store';
import { asTextContent, type Toolset } from './tools/shared.js';

export interface McpConnectionStatus {
  serverId: string;
  serverName: string;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
  lastError?: string;
  connectedAt?: string;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface McpConnectionState {
  serverId: string;
  serverName: string;
  status: 'connected' | 'disconnected' | 'error';
  client?: Client;
  transport?: StreamableHTTPClientTransport;
  tools: McpToolInfo[];
  lastError?: string;
  connectedAt?: string;
}

export class McpClientManager {
  private connections = new Map<string, McpConnectionState>();

  async connectAll(servers: McpServerRecord[]): Promise<void> {
    await Promise.all(servers.map((s) => this.connect(s)));
  }

  async connect(server: McpServerRecord): Promise<void> {
    await this.disconnect(server.id);

    const state: McpConnectionState = {
      serverId: server.id,
      serverName: server.name,
      status: 'disconnected',
      tools: [],
    };
    this.connections.set(server.id, state);

    try {
      const headers: Record<string, string> = {
        ...server.headers,
      };
      const transport = new StreamableHTTPClientTransport(
        new URL(server.url),
        { requestInit: { headers } },
      );
      const client = new Client({ name: 'openhermit', version: '0.2.0' });
      await client.connect(transport);

      const { tools } = await client.listTools();

      state.client = client;
      state.transport = transport;
      state.status = 'connected';
      state.connectedAt = new Date().toISOString();
      state.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } catch (err) {
      state.status = 'error';
      state.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp] failed to connect to ${server.id}: ${state.lastError}`);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const state = this.connections.get(serverId);
    if (!state) return;

    if (state.client) {
      try { await state.client.close(); } catch { /* ignore */ }
    }
    this.connections.delete(serverId);
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  getToolsets(): Toolset[] {
    const toolsets: Toolset[] = [];
    for (const state of this.connections.values()) {
      if (state.status !== 'connected' || state.tools.length === 0) continue;

      const tools: AgentTool<any>[] = state.tools.map((mcpTool) =>
        this.adaptTool(state, mcpTool),
      );

      toolsets.push({
        id: `mcp__${state.serverId}`,
        description: `Tools from MCP server: ${state.serverName}`,
        tools,
      });
    }
    return toolsets;
  }

  getStatus(): McpConnectionStatus[] {
    return [...this.connections.values()].map((s) => ({
      serverId: s.serverId,
      serverName: s.serverName,
      status: s.status,
      toolCount: s.tools.length,
      ...(s.lastError ? { lastError: s.lastError } : {}),
      ...(s.connectedAt ? { connectedAt: s.connectedAt } : {}),
    }));
  }

  hasServer(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  private adaptTool(state: McpConnectionState, mcpTool: McpToolInfo): AgentTool<any> {
    const toolName = `mcp__${state.serverId}__${mcpTool.name}`;

    return {
      name: toolName,
      label: `[${state.serverName}] ${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${state.serverName}`,
      parameters: Type.Unsafe(mcpTool.inputSchema),
      execute: async (_toolCallId, params) => {
        if (!state.client || state.status !== 'connected') {
          return {
            content: asTextContent(`MCP server "${state.serverName}" is not connected.`),
            details: {},
          };
        }
        try {
          const result = await state.client.callTool({
            name: mcpTool.name,
            arguments: params as Record<string, unknown>,
          });

          const textParts: string[] = [];
          if (Array.isArray(result.content)) {
            for (const part of result.content) {
              if (part.type === 'text') textParts.push(part.text);
              else if (part.type === 'image') textParts.push(`[image: ${part.mimeType}]`);
              else textParts.push(JSON.stringify(part));
            }
          }

          const text = textParts.length > 0 ? textParts.join('\n') : JSON.stringify(result);
          return {
            content: asTextContent(result.isError ? `Error: ${text}` : text),
            details: {},
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          state.status = 'error';
          state.lastError = msg;
          return {
            content: asTextContent(`MCP tool call failed: ${msg}`),
            details: {},
          };
        }
      },
    };
  }
}
