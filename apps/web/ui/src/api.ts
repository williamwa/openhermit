// ─── Storage keys ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'openhermit_connection';
const DEVICE_KEY_STORAGE = 'openhermit_device_key';
const JWT_STORAGE = 'openhermit_jwt';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Connection {
  gatewayUrl: string;
  agentId: string;
  token?: string;
}

export interface TokenExchangeResult {
  token: string;
  expiresAt: number;
  isNewDevice: boolean;
  displayName?: string;
  role?: string;
}

export interface SessionSummary {
  sessionId: string;
  source: { kind: string; platform?: string; interactive: boolean };
  status: string;
  createdAt: string;
  lastActivityAt: string;
  lastEventId: number;
  messageCount: number;
  description?: string;
  lastMessagePreview?: string;
  metadata?: Record<string, unknown>;
}

export interface HistoryMessage {
  role: string;
  content: string;
  name?: string;
  thinking?: string;
  tool?: string;
  toolPhase?: 'call' | 'result';
  toolIsError?: boolean;
  toolArgs?: unknown;
  introspectionPhase?: 'start' | 'end';
  introspectionSummary?: string;
}

export interface OutboundEvent {
  type: string;
  sessionId: string;
  [key: string]: unknown;
}

// ─── Device Key (ECDSA P-256) ──────────────────────────────────────────────

const bufToBase64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

interface KeyPairResult {
  isNew: boolean;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
}

interface StoredDevice {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
  displayName?: string;
}

const readDeviceStorage = (): StoredDevice | null => {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY_STORAGE) || 'null');
  } catch {
    return null;
  }
};

const writeDeviceStorage = (data: StoredDevice): void => {
  localStorage.setItem(DEVICE_KEY_STORAGE, JSON.stringify(data));
};

const loadOrCreateKeyPair = async (): Promise<KeyPairResult> => {
  const stored = readDeviceStorage();
  if (stored) {
    try {
      return {
        isNew: false,
        publicKey: await crypto.subtle.importKey('jwk', stored.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
        privateKey: await crypto.subtle.importKey('jwk', stored.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
      };
    } catch {
      localStorage.removeItem(DEVICE_KEY_STORAGE);
    }
  }
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const exported: StoredDevice = {
    publicKey: await crypto.subtle.exportKey('jwk', keyPair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', keyPair.privateKey),
  };
  writeDeviceStorage(exported);
  return { isNew: true, ...keyPair };
};

let deviceKeyPair: KeyPairResult | null = null;

export const isNewDevice = (): boolean => deviceKeyPair?.isNew ?? !localStorage.getItem(DEVICE_KEY_STORAGE);

export const getDeviceFingerprint = async (): Promise<string> => {
  if (!deviceKeyPair) deviceKeyPair = await loadOrCreateKeyPair();
  const rawPub = await crypto.subtle.exportKey('raw', deviceKeyPair.publicKey);
  const hash = await crypto.subtle.digest('SHA-256', rawPub);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
};

const generateDeviceKeyCredential = async (): Promise<string> => {
  if (!deviceKeyPair) deviceKeyPair = await loadOrCreateKeyPair();
  const rawPub = await crypto.subtle.exportKey('raw', deviceKeyPair.publicKey);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = new TextEncoder().encode(timestamp);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, deviceKeyPair.privateKey, payload);
  return `${bufToBase64url(rawPub)}.${timestamp}.${bufToBase64url(signature)}`;
};

// ─── Connection ────────────────────────────────────────────────────────────

let apiBase = '';

export const loadConnection = (): Connection | null => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
};

export const saveConnection = (conn: Connection): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
};

export const clearConnection = (): void => {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(JWT_STORAGE);
};

let gatewayBase = '';
let currentAgentId = '';

export const setConnection = (conn: Connection): void => {
  const base = conn.gatewayUrl.replace(/\/+$/, '');
  gatewayBase = base;
  currentAgentId = conn.agentId;
  apiBase = `${base}/agents/${encodeURIComponent(conn.agentId)}`;
};

export const getApiBase = (): string => apiBase;

// ─── Display name ──────────────────────────────────────────────────────────

export const getDisplayName = (): string | null => readDeviceStorage()?.displayName ?? null;

export const setDisplayName = (name: string): void => {
  const stored = readDeviceStorage();
  if (stored) {
    stored.displayName = name;
    writeDeviceStorage(stored);
  }
};

// ─── JWT management ────────────────────────────────────────────────────────

let jwtToken: string | null = null;
let jwtExpiresAt = 0;
let userRole: string | null = null;

const loadJwt = (): void => {
  try {
    const stored = JSON.parse(localStorage.getItem(JWT_STORAGE) || 'null');
    if (stored?.token && stored?.expiresAt) {
      jwtToken = stored.token;
      jwtExpiresAt = stored.expiresAt;
    }
  } catch {
    localStorage.removeItem(JWT_STORAGE);
  }
};

const saveJwt = (token: string, expiresAt: number): void => {
  jwtToken = token;
  jwtExpiresAt = expiresAt;
  localStorage.setItem(JWT_STORAGE, JSON.stringify({ token, expiresAt }));
};

const isJwtValid = (): boolean =>
  !!jwtToken && jwtExpiresAt > Math.floor(Date.now() / 1000) + 60;

export const exchangeToken = async (displayName?: string | null): Promise<TokenExchangeResult> => {
  const deviceKey = await generateDeviceKeyCredential();
  const body: Record<string, unknown> = { grant_type: 'device-key', device_key: deviceKey };

  if (displayName) body.display_name = displayName;

  const conn = loadConnection();
  if (conn?.token) body.agent_token = conn.token;

  const response = await fetch(`${apiBase}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `Token exchange failed (${response.status})`);
  }

  const result = await response.json() as TokenExchangeResult;
  saveJwt(result.token, result.expiresAt);
  if (result.role) userRole = result.role;
  return result;
};

export const getJwt = async (): Promise<string> => {
  if (isJwtValid()) return jwtToken!;
  const result = await exchangeToken(getDisplayName());
  return result.token;
};

export const initJwt = (): void => { loadJwt(); };

// ─── WebSocket RPC client ─────────────────────────────────────────────────

type WsMethod =
  | 'session.open'
  | 'session.message'
  | 'session.approve'
  | 'session.checkpoint'
  | 'session.delete'
  | 'session.list'
  | 'session.history'
  | 'session.subscribe'
  | 'session.unsubscribe';

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export type WsEventHandler = (eventId: number, sessionId: string, event: OutboundEvent) => void;
export type WsStatusHandler = (status: 'connecting' | 'connected' | 'disconnected') => void;

export class AgentWsClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private onEvent: WsEventHandler;
  private onStatus: WsStatusHandler;
  private onReconnect: (() => void) | null = null;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions = new Map<string, number>(); // sessionId → lastEventId

  constructor(onEvent: WsEventHandler, onStatus: WsStatusHandler) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  setOnReconnect(cb: () => void): void { this.onReconnect = cb; }

  async connect(): Promise<void> {
    const token = await getJwt();
    const httpBase = getApiBase();
    const wsBase = httpBase.replace(/^http/, 'ws');
    const url = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

    this.onStatus('connecting');

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.onStatus('connected');
        resolve();
      };

      ws.onerror = () => {
        if (!this.ws) reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error('Connection closed'));
        this.pending.clear();
        this.ws = null;
        if (!this.disposed) {
          this.onStatus('disconnected');
          this.scheduleReconnect();
        }
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.kind === 'response') {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          } else if (msg.kind === 'event') {
            this.onEvent(msg.eventId, msg.sessionId, msg.event);
          }
        } catch { /* ignore malformed messages */ }
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, 30_000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.disposed) return;
      this.onStatus('connecting');
      this.connect()
        .then(() => this.resubscribe())
        .then(() => this.onReconnect?.())
        .catch(() => {});
    }, delay);
  }

  private async resubscribe(): Promise<void> {
    for (const [sessionId, lastEventId] of this.subscriptions) {
      await this.send('session.subscribe', { sessionId, lastEventId }).catch(() => {});
    }
  }

  private send<T = unknown>(method: WsMethod, params?: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = String(++this.requestId);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws!.send(JSON.stringify({ kind: 'request', id, method, params }));
    });
  }

  async listSessions(limit = 50): Promise<SessionSummary[]> {
    return this.send('session.list', { limit });
  }

  async openSession(sessionId: string): Promise<void> {
    await this.send('session.open', {
      sessionId,
      source: { kind: 'api', interactive: true, platform: 'web' },
      metadata: {},
    });
  }

  async getHistory(sessionId: string): Promise<HistoryMessage[]> {
    return this.send('session.history', { sessionId });
  }

  async subscribe(sessionId: string, lastEventId?: number): Promise<void> {
    this.subscriptions.set(sessionId, lastEventId ?? 0);
    await this.send('session.subscribe', { sessionId, lastEventId });
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.subscriptions.delete(sessionId);
    await this.send('session.unsubscribe', { sessionId }).catch(() => {});
  }

  async sendMessage(sessionId: string, text: string): Promise<void> {
    await this.send('session.message', { sessionId, text });
  }

  async approve(sessionId: string, toolCallId: string, approved: boolean): Promise<void> {
    await this.send('session.approve', { sessionId, toolCallId, approved });
  }

  async checkpoint(sessionId: string, reason: string): Promise<void> {
    await this.send('session.checkpoint', { sessionId, reason });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.send('session.delete', { sessionId });
  }

  checkConnection(): void {
    if (this.disposed) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.scheduleReconnect();
    }
  }

  close(): void {
    this.disposed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.ws?.close();
    this.ws = null;
  }

  private handleVisibility = (): void => {
    if (document.visibilityState === 'visible') this.checkConnection();
  };

  startVisibilityCheck(): void {
    document.addEventListener('visibilitychange', this.handleVisibility);
  }
}

// ─── User role ────────────────────────────────────────────────────────────

export const getUserRole = (): string | null => userRole;

// ─── REST API helpers for management ──────────────────────────────────────

async function rawFetch<T>(url: string, options?: { method?: string; body?: unknown }): Promise<T> {
  const token = await getJwt();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let bodyStr: string | undefined;
  if (options?.body !== undefined) {
    headers['content-type'] = 'application/json';
    bodyStr = JSON.stringify(options.body);
  }
  const res = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    ...(bodyStr ? { body: bodyStr } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } }).error?.message || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function apiFetch<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  return rawFetch<T>(`${gatewayBase}/api/agents/${encodeURIComponent(currentAgentId)}${path}`, options);
}

/** Call a non-agent-scoped gateway endpoint (e.g. /api/providers). */
export async function apiFetchGlobal<T>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
  return rawFetch<T>(`${gatewayBase}${path}`, options);
}

// Agent info
export interface AgentInfo { agentId: string; name: string; status: string }
export const fetchAgentInfo = () => apiFetch<AgentInfo>('/info');

// Skills
export interface SkillInfo { id: string; name: string; description: string; path: string; source: string }
export const fetchSkills = () => apiFetch<SkillInfo[]>('/skills');
export const enableSkill = (id: string) => apiFetch<{ ok: boolean }>(`/skills/${encodeURIComponent(id)}/enable`, { method: 'POST' });
export const disableSkill = (id: string) => apiFetch<{ ok: boolean }>(`/skills/${encodeURIComponent(id)}/disable`, { method: 'POST' });

// MCP Servers
export interface McpServerInfo { id: string; name: string; description: string; url: string }
export const fetchMcpServers = () => apiFetch<McpServerInfo[]>('/mcp-servers');
export const enableMcpServer = (id: string) => apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(id)}/enable`, { method: 'POST' });
export const disableMcpServer = (id: string) => apiFetch<{ ok: boolean }>(`/mcp-servers/${encodeURIComponent(id)}/disable`, { method: 'POST' });

// Schedules
export interface ScheduleInfo {
  scheduleId: string; type: string; status: string; prompt: string;
  cronExpression?: string; runAt?: string; delivery?: unknown;
  runCount: number; nextRunAt?: string; lastRunAt?: string;
  consecutiveErrors: number; createdAt: string; updatedAt: string;
}
export interface ScheduleRunInfo {
  runId: string; status: string; startedAt: string; finishedAt?: string;
  durationMs?: number; sessionId?: string; error?: string;
}
export const fetchSchedules = () => apiFetch<ScheduleInfo[]>('/schedules');
export const createSchedule = (data: Record<string, unknown>) => apiFetch<ScheduleInfo>('/schedules', { method: 'POST', body: data });
export const updateSchedule = (id: string, data: Record<string, unknown>) => apiFetch<ScheduleInfo>(`/schedules/${encodeURIComponent(id)}`, { method: 'PUT', body: data });
export const deleteSchedule = (id: string) => apiFetch<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const triggerSchedule = (id: string) => apiFetch<{ ok: boolean }>(`/schedules/${encodeURIComponent(id)}/trigger`, { method: 'POST' });
export const fetchScheduleRuns = (id: string) => apiFetch<ScheduleRunInfo[]>(`/schedules/${encodeURIComponent(id)}/runs`);

// Channels
export interface ChannelSecretKey { key: string; label: string; placeholder: string }
export interface ChannelInfo { id: string; label: string; configured: boolean; enabled: boolean; secretsSet: boolean; secretKeys: ChannelSecretKey[]; status?: string; error?: string }
export const fetchChannels = () => apiFetch<ChannelInfo[]>('/channels');
export const enableChannel = (id: string) => apiFetch<{ ok: boolean }>(`/channels/${encodeURIComponent(id)}/enable`, { method: 'POST' });
export const disableChannel = (id: string) => apiFetch<{ ok: boolean }>(`/channels/${encodeURIComponent(id)}/disable`, { method: 'POST' });
export const configureChannel = (id: string, secrets: Record<string, string>) => apiFetch<{ ok: boolean }>(`/channels/${encodeURIComponent(id)}`, { method: 'PUT', body: { secrets } });
export const removeChannel = (id: string) => apiFetch<{ ok: boolean }>(`/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });

// Agent config (basic settings)
export interface AgentConfig {
  workspace_root?: string;
  model: { provider: string; model: string; max_tokens?: number; thinking?: 'off' | 'minimal' | 'low' | 'medium' | 'high'; base_url?: string; api?: string };
  [key: string]: unknown;
}
export const fetchAgentConfig = () => apiFetch<AgentConfig>('/config');
export const putAgentConfig = (config: AgentConfig) => apiFetch<{ ok: boolean }>('/config', { method: 'PUT', body: config });

// Provider catalog (static, global — sourced from pi-ai's model registry)
export interface ProviderCatalogEntry { provider: string; models: { id: string }[] }
export const fetchProviderCatalog = () => apiFetchGlobal<ProviderCatalogEntry[]>('/api/providers');
