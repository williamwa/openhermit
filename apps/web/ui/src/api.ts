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

export const setConnection = (conn: Connection): void => {
  const base = conn.gatewayUrl.replace(/\/+$/, '');
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
  return result;
};

export const getJwt = async (): Promise<string> => {
  if (isJwtValid()) return jwtToken!;
  const result = await exchangeToken(getDisplayName());
  return result.token;
};

export const initJwt = (): void => { loadJwt(); };

// ─── Authenticated fetch ───────────────────────────────────────────────────

export const apiFetch = async (path: string, options: RequestInit = {}): Promise<Response> => {
  const token = await getJwt();
  const headers = { authorization: `Bearer ${token}`, ...(options.headers || {}) };
  return fetch(`${apiBase}${path}`, { ...options, headers });
};
