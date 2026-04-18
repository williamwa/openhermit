/**
 * Gateway authentication layer.
 *
 * Two authentication modes:
 *
 * 1. **User auth** — End-users (web, mobile) authenticate directly via a
 *    pluggable `UserAuthProvider`.  The provider verifies credentials and
 *    returns a verified identity.
 *
 * 2. **Channel auth** — External channels (Telegram, Discord, third-party bots)
 *    authenticate with a pre-shared API key.  The channel declares per-message
 *    user identity via `MessageSender`; the gateway trusts it but enforces
 *    namespace isolation (a Telegram channel key can only claim `telegram:*`
 *    identities).
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Verified identity attached to every authenticated request. */
export interface AuthContext {
  /** Authentication mode that produced this context. */
  mode: 'user' | 'channel';

  /** Resolved internal userId (may be undefined for first-time users). */
  userId?: string;

  /** Channel + channelUserId for identity resolution by AgentRunner. */
  channel: string;
  channelUserId: string;

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
 * Implementations verify user-supplied credentials (password, OAuth token,
 * passkey, etc.) and return a verified channel identity.  The gateway maps
 * this to an internal userId via the existing UserStore identity link system.
 *
 * Example providers:
 *  - DeviceIdProvider  (current: unsigned device UUID — for development)
 *  - EmailPassword     (future: email + bcrypt password)
 *  - OAuthProvider     (future: Google, X, GitHub, etc.)
 */
export interface UserAuthProvider {
  /** Unique provider id, e.g. "device-id", "email-password", "google-oauth". */
  readonly id: string;

  /**
   * Extract and verify credentials from the incoming request.
   * Return a verified identity or null if this provider doesn't apply
   * (e.g. wrong header format, missing credentials).
   *
   * Throw an `UnauthorizedError` if credentials are present but invalid.
   */
  authenticate(request: Request): Promise<UserAuthResult | null>;
}

export interface UserAuthResult {
  /** Channel name for identity linking, e.g. "web", "web-email", "web-google". */
  channel: string;
  /** Channel-scoped user id, e.g. email address, OAuth sub, device UUID. */
  channelUserId: string;
  /** Optional display name. */
  displayName?: string;
}

/**
 * Registered external channel.
 *
 * Each channel gets a pre-shared API key and a namespace.  When a channel
 * sends a message with a `sender` field, the gateway enforces that
 * `sender.channel` matches the registered namespace.
 */
export interface ChannelRegistration {
  /** Channel identifier, e.g. "telegram", "discord", "my-custom-bot". */
  channelId: string;
  /** Pre-shared API key (Bearer token). */
  apiKey: string;
  /**
   * Allowed identity namespace.  Sender identities declared by this channel
   * must have `sender.channel === namespace`.  Defaults to `channelId`.
   */
  namespace?: string;
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

  resolveByKey(apiKey: string): ChannelRegistration | undefined {
    return this.byKey.get(apiKey);
  }

  resolveById(channelId: string): ChannelRegistration | undefined {
    return this.byId.get(channelId);
  }

  getNamespace(registration: ChannelRegistration): string {
    return registration.namespace ?? registration.channelId;
  }

  /**
   * Validate that a sender identity is within the channel's namespace.
   * Returns true if the sender's channel matches the registration's namespace.
   */
  validateSenderNamespace(
    registration: ChannelRegistration,
    senderChannel: string,
  ): boolean {
    return senderChannel === this.getNamespace(registration);
  }
}

// ── Device ID provider (development / initial implementation) ──────────────

/**
 * Simple auth provider that trusts a client-supplied device UUID.
 *
 * This is NOT secure for production — anyone can forge a device ID.
 * It exists as the initial implementation so the web client keeps working
 * while we build proper auth providers (email/password, OAuth).
 *
 * Reads the device ID from `X-Device-Id` header.
 */
export class DeviceIdAuthProvider implements UserAuthProvider {
  readonly id = 'device-id';

  async authenticate(request: Request): Promise<UserAuthResult | null> {
    const deviceId = request.headers.get('x-device-id');
    if (!deviceId) return null;

    return {
      channel: 'web',
      channelUserId: deviceId,
    };
  }
}

// ── Auth resolution ────────────────────────────────────────────────────────

export interface AuthResolverOptions {
  /** User auth providers, tried in order. */
  userProviders: UserAuthProvider[];
  /** Channel registry for API key auth. */
  channels: ChannelRegistry;
}

/**
 * Resolve authentication from a request.
 *
 * Order:
 * 1. Try channel auth (Bearer token matches a registered channel key)
 * 2. Try user auth providers in order
 * 3. Return null (unauthenticated)
 */
export const resolveAuth = async (
  request: Request,
  options: AuthResolverOptions,
): Promise<AuthContext | null> => {
  const authorization = request.headers.get('authorization');

  // 1. Channel auth: Bearer token matches a registered channel key
  if (authorization?.startsWith('Bearer ')) {
    const token = authorization.slice(7);
    const channel = options.channels.resolveByKey(token);
    if (channel) {
      const namespace = options.channels.getNamespace(channel);
      return {
        mode: 'channel',
        channel: namespace,
        channelUserId: '', // filled per-message from sender field
        channelNamespace: namespace,
      };
    }
  }

  // 2. User auth providers
  for (const provider of options.userProviders) {
    const result = await provider.authenticate(request);
    if (result) {
      return {
        mode: 'user',
        channel: result.channel,
        channelUserId: result.channelUserId,
        ...(result.displayName ? { displayName: result.displayName } : {}),
      };
    }
  }

  return null;
};
