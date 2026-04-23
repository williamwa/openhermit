/**
 * Gateway authentication layer.
 *
 * Three authentication modes:
 *
 * 1. **Admin auth** — Gateway-level management token (`GATEWAY_ADMIN_TOKEN`).
 *    Used for agent CRUD and lifecycle operations.
 *
 * 2. **User auth (JWT)** — End-users exchange credentials (device-key, etc.)
 *    for a short-lived JWT via `POST /agents/:agentId/auth/token`.
 *    All subsequent agent API calls use `Authorization: Bearer <jwt>`.
 *
 * 3. **Channel auth** — External channels (Telegram, Discord, third-party bots)
 *    authenticate with a pre-shared API key.  The channel declares per-message
 *    user identity via `MessageSender`; the gateway trusts it but enforces
 *    namespace isolation.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

// ── Types ──────────────────────────────────────────────────────────────────

/** Verified identity attached to every authenticated request. */
export interface AuthContext {
  /** Authentication mode that produced this context. */
  mode: 'user' | 'channel' | 'admin';

  /** Resolved internal userId (may be undefined for first-time users). */
  userId?: string;

  /** Channel + channelUserId for identity resolution by AgentRunner. */
  channel: string;
  channelUserId: string;

  /** The agentId this JWT was issued for (user mode only). */
  agentId?: string;

  /** Display name (optional). */
  displayName?: string;

  /**
   * For channel auth: the channelId that was authenticated.
   * Channel-declared sender identities must match this namespace.
   */
  channelNamespace?: string;
}

/**
 * Pluggable user authentication provider.
 *
 * Implementations verify user-supplied credentials and return a verified
 * channel identity.  Used during token exchange, not on every request.
 */
export interface UserAuthProvider {
  /** Unique provider id, e.g. "device-key", "email-password", "google-oauth". */
  readonly id: string;

  /**
   * Verify credentials from the token exchange request body.
   * Return a verified identity or null if this provider doesn't apply.
   */
  authenticate(body: Record<string, unknown>): Promise<UserAuthResult | null>;
}

export interface UserAuthResult {
  /** Channel name for identity linking, e.g. "web", "web-email", "web-google". */
  channel: string;
  /** Channel-scoped user id, e.g. email address, OAuth sub, device fingerprint. */
  channelUserId: string;
  /** Optional display name. */
  displayName?: string;
}

/**
 * Registered external channel.
 */
export interface ChannelRegistration {
  channelId: string;
  apiKey: string;
  namespace?: string;
  /** The agent this channel token is scoped to. */
  agentId: string;
}

// ── Channel registry ───────────────────────────────────────────────────────

export class ChannelRegistry {
  private readonly byKey = new Map<string, ChannelRegistration>();
  private readonly byId = new Map<string, ChannelRegistration>();

  register(registration: ChannelRegistration): void {
    this.byKey.set(registration.apiKey, registration);
    this.byId.set(registration.channelId, registration);
  }

  unregister(channelId: string): void {
    const reg = this.byId.get(channelId);
    if (reg) {
      this.byKey.delete(reg.apiKey);
      this.byId.delete(channelId);
    }
  }

  /** Remove all channel registrations belonging to an agent. */
  unregisterByAgent(agentId: string): void {
    for (const [id, reg] of this.byId) {
      if (reg.agentId === agentId) {
        this.byKey.delete(reg.apiKey);
        this.byId.delete(id);
      }
    }
  }

  resolveByKey(apiKey: string): ChannelRegistration | undefined {
    return this.byKey.get(apiKey);
  }

  resolveById(channelId: string): ChannelRegistration | undefined {
    return this.byId.get(channelId);
  }

  getNamespace(registration: ChannelRegistration): string {
    return registration.namespace ?? registration.channelId;
  }

  validateSenderNamespace(
    registration: ChannelRegistration,
    senderChannel: string,
  ): boolean {
    return senderChannel === this.getNamespace(registration);
  }
}

// ── Device Key provider (asymmetric key auth) ────────────────────────────────

const DEVICE_KEY_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

const base64urlDecode = (s: string): Uint8Array => {
  const base64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const bufferToHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Auth provider using client-generated ECDSA P-256 keypair.
 *
 * Token exchange body:
 * ```json
 * {
 *   "grant_type": "device-key",
 *   "device_key": "<base64url(rawPublicKey)>.<unixSeconds>.<base64url(signature)>"
 * }
 * ```
 */
export class DeviceKeyAuthProvider implements UserAuthProvider {
  readonly id = 'device-key';

  async authenticate(body: Record<string, unknown>): Promise<UserAuthResult | null> {
    if (body.grant_type !== 'device-key') return null;

    const deviceKey = body.device_key;
    if (typeof deviceKey !== 'string') return null;

    const parts = deviceKey.split('.');
    if (parts.length !== 3) return null;

    const [pubKeyB64, timestampStr, signatureB64] = parts as [string, string, string];

    // Validate timestamp freshness
    const timestamp = Number.parseInt(timestampStr, 10);
    if (Number.isNaN(timestamp)) return null;
    const age = Math.abs(Date.now() - timestamp * 1000);
    if (age > DEVICE_KEY_MAX_AGE_MS) return null;

    // Decode key and signature
    const rawPublicKey = base64urlDecode(pubKeyB64).buffer as ArrayBuffer;
    const signatureBytes = base64urlDecode(signatureB64).buffer as ArrayBuffer;

    // Import the public key
    let publicKey: CryptoKey;
    try {
      publicKey = await crypto.subtle.importKey(
        'raw',
        rawPublicKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      );
    } catch {
      return null;
    }

    // Verify signature over the timestamp bytes
    const payload = new TextEncoder().encode(timestampStr);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      signatureBytes,
      payload,
    );
    if (!valid) return null;

    // Derive stable device identifier from public key fingerprint
    const fingerprint = bufferToHex(await crypto.subtle.digest('SHA-256', rawPublicKey));

    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : undefined;

    return {
      channel: 'web',
      channelUserId: fingerprint,
      ...(displayName ? { displayName } : {}),
    };
  }
}

// ── JWT token management ──────────────────────────────────────────────────

const JWT_DEFAULT_EXPIRY = '24h';

export interface JwtConfig {
  /** HMAC-SHA256 secret. Auto-generated if not provided. */
  secret: Uint8Array;
  /** Token expiry (jose duration string). Default: '24h'. */
  expiry?: string;
}

export interface JwtTokenPayload extends JWTPayload {
  /** Subject: "channel:channelUserId" */
  sub: string;
  /** Agent ID this token is scoped to. */
  agentId: string;
  /** Channel name. */
  channel: string;
  /** Channel user ID. */
  channelUserId: string;
}

export const createJwtConfig = (secretEnv?: string): JwtConfig => {
  let secret: Uint8Array;
  if (secretEnv) {
    secret = new TextEncoder().encode(secretEnv);
  } else {
    // Auto-generate a random secret (ephemeral — tokens won't survive restarts)
    secret = crypto.getRandomValues(new Uint8Array(32));
  }
  return { secret };
};

export const signJwt = async (
  config: JwtConfig,
  payload: { agentId: string; channel: string; channelUserId: string },
): Promise<{ token: string; expiresAt: number }> => {
  const expiry = config.expiry ?? JWT_DEFAULT_EXPIRY;
  const jwt = await new SignJWT({
    agentId: payload.agentId,
    channel: payload.channel,
    channelUserId: payload.channelUserId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(`${payload.channel}:${payload.channelUserId}`)
    .setIssuedAt()
    .setExpirationTime(expiry)
    .sign(config.secret);

  // Decode exp from the JWT to return it
  const [, payloadB64] = jwt.split('.');
  const decoded = JSON.parse(atob(payloadB64!.replace(/-/g, '+').replace(/_/g, '/'))) as { exp: number };

  return { token: jwt, expiresAt: decoded.exp };
};

export const verifyJwt = async (
  config: JwtConfig,
  token: string,
): Promise<JwtTokenPayload | null> => {
  try {
    const { payload } = await jwtVerify(token, config.secret);
    if (!payload.sub || !payload.agentId || !payload.channel || !payload.channelUserId) {
      return null;
    }
    return payload as JwtTokenPayload;
  } catch {
    return null;
  }
};

// ── Admin token ───────────────────────────────────────────────────────────

export const verifyAdminToken = (
  adminToken: string | undefined,
  authorization: string | undefined,
): boolean => {
  if (!adminToken) return false;
  if (!authorization?.startsWith('Bearer ')) return false;
  return authorization.slice(7) === adminToken;
};

// ── Auth resolution ────────────────────────────────────────────────────────

export interface AuthResolverOptions {
  /** User auth providers, tried in order during token exchange. */
  userProviders: UserAuthProvider[];
  /** Channel registry for API key auth. */
  channels: ChannelRegistry;
  /** JWT configuration. */
  jwt: JwtConfig;
  /** Admin token — grants full access when used as Bearer token. */
  adminToken?: string | undefined;
}

/**
 * Resolve authentication from a request.
 *
 * Order:
 * 1. Try JWT verification (Bearer token is a valid JWT)
 * 2. Try channel auth (Bearer token matches a registered channel key)
 * 3. Return null (unauthenticated)
 */
/**
 * Resolve authentication from a request.
 *
 * Order:
 * 1. Extract Bearer token from Authorization header (or `token` query param for SSE)
 * 2. Try JWT verification
 * 3. Try channel auth (pre-shared key)
 * 4. Return null (unauthenticated)
 */
export const resolveAuth = async (
  request: Request,
  options: AuthResolverOptions,
): Promise<AuthContext | null> => {
  const authorization = request.headers.get('authorization');

  // Extract token from header or query param (EventSource can't set headers)
  let bearerToken: string | undefined;
  if (authorization?.startsWith('Bearer ')) {
    bearerToken = authorization.slice(7);
  } else {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get('token');
    if (queryToken) bearerToken = queryToken;
  }

  if (bearerToken) {
    // 0. Admin token — full access
    if (options.adminToken && bearerToken === options.adminToken) {
      return { mode: 'admin' as const, channel: 'admin', channelUserId: 'admin' };
    }

    // 1. Try JWT
    const jwtPayload = await verifyJwt(options.jwt, bearerToken);
    if (jwtPayload) {
      return {
        mode: 'user',
        channel: jwtPayload.channel as string,
        channelUserId: jwtPayload.channelUserId as string,
        agentId: jwtPayload.agentId as string,
      };
    }

    // 2. Channel auth: Bearer token matches a registered channel key
    const channel = options.channels.resolveByKey(bearerToken);
    if (channel) {
      const namespace = options.channels.getNamespace(channel);
      return {
        mode: 'channel',
        channel: namespace,
        channelUserId: '', // filled per-message from sender field
        channelNamespace: namespace,
        agentId: channel.agentId,
      };
    }
  }

  return null;
};
