import crypto from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq, isNull } from 'drizzle-orm';
import pg from 'pg';

import * as schema from '../schema.js';
import { agentChannels } from '../schema.js';
import {
  decryptString as decrypt,
  encryptString as encrypt,
  secretsKeyFromEnv,
} from './secret-crypto.js';
import type { DrizzleDb } from './index.js';

/**
 * Owner-registered external channel adapters. Each row owns one access
 * token issued at creation time:
 *  - the **plaintext** is shown to the creator exactly once (in the API
 *    response) so they can paste it into the external adapter's config;
 *  - we keep an encrypted copy in the DB so the gateway can decrypt
 *    every entry at boot and seed ChannelRegistry without needing a
 *    plaintext-recovery flow.
 *
 * Encryption key is OPENHERMIT_SECRETS_KEY — same key as DbSecretStore;
 * losing it means losing every external-channel token along with every
 * agent secret.
 */
export interface AgentChannelRow {
  id: string;
  agentId: string;
  namespace: string;
  label: string | null;
  tokenPrefix: string;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface CreatedAgentChannel extends AgentChannelRow {
  /** Plaintext token. Returned ONLY at creation; never re-derivable from list/get. */
  token: string;
}

export interface AgentChannelLoaded {
  id: string;
  agentId: string;
  namespace: string;
  /** Decrypted plaintext, used by the gateway to seed ChannelRegistry at boot. */
  token: string;
}

const CHANNEL_TOKEN_PREFIX = 'oh_ch_';

const generateChannelToken = (): string =>
  CHANNEL_TOKEN_PREFIX + crypto.randomBytes(24).toString('hex');

const generateChannelId = (): string =>
  `chr-${crypto.randomBytes(8).toString('hex')}`;

export class DbAgentChannelStore {
  private pool?: pg.Pool;

  private constructor(
    private readonly db: DrizzleDb,
    private readonly key: Buffer,
  ) {}

  static async open(databaseUrl?: string): Promise<DbAgentChannelStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAgentChannelStore(db, secretsKeyFromEnv());
    store.pool = pool;
    return store;
  }

  static withDb(db: DrizzleDb): DbAgentChannelStore {
    return new DbAgentChannelStore(db, secretsKeyFromEnv());
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  /**
   * Issue a new channel token. Returns the row plus the plaintext token —
   * plaintext is only visible here, never on subsequent reads.
   */
  async create(input: {
    agentId: string;
    namespace: string;
    label?: string;
    createdBy?: string;
  }): Promise<CreatedAgentChannel> {
    const id = generateChannelId();
    const token = generateChannelToken();
    const tokenPrefix = token.slice(0, 12);
    const tokenCiphertext = encrypt(this.key, token);
    const now = new Date().toISOString();

    await this.db.insert(agentChannels).values({
      id,
      agentId: input.agentId,
      namespace: input.namespace,
      label: input.label ?? null,
      tokenPrefix,
      tokenCiphertext,
      createdBy: input.createdBy ?? null,
      createdAt: now,
    });

    return {
      id,
      agentId: input.agentId,
      namespace: input.namespace,
      label: input.label ?? null,
      tokenPrefix,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
      token,
    };
  }

  /**
   * List active (non-revoked) channels for an agent. Token plaintext is
   * NOT returned — only the prefix for display.
   */
  async listForAgent(agentId: string): Promise<AgentChannelRow[]> {
    const rows = await this.db.select().from(agentChannels)
      .where(and(eq(agentChannels.agentId, agentId), isNull(agentChannels.revokedAt)))
      .orderBy(asc(agentChannels.createdAt));
    return rows.map(rowToPublic);
  }

  /** Soft-delete: mark revoked so it stops resolving. */
  async revoke(id: string): Promise<void> {
    await this.db.update(agentChannels)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(agentChannels.id, id));
  }

  async get(id: string): Promise<AgentChannelRow | undefined> {
    const [row] = await this.db.select().from(agentChannels).where(eq(agentChannels.id, id));
    return row ? rowToPublic(row) : undefined;
  }

  /**
   * Decrypt every active channel token for boot-time loading into
   * ChannelRegistry. Decryption failures (e.g. key rotated) are skipped
   * with a warning rather than crashing the gateway.
   */
  async loadActive(): Promise<AgentChannelLoaded[]> {
    const rows = await this.db.select().from(agentChannels)
      .where(isNull(agentChannels.revokedAt));
    const out: AgentChannelLoaded[] = [];
    for (const row of rows) {
      try {
        const token = decrypt(this.key, row.tokenCiphertext);
        out.push({ id: row.id, agentId: row.agentId, namespace: row.namespace, token });
      } catch {
        // Encryption key changed or row corrupted — skip silently. The
        // owner can revoke + reissue from the admin UI.
      }
    }
    return out;
  }
}

const rowToPublic = (row: typeof agentChannels.$inferSelect): AgentChannelRow => ({
  id: row.id,
  agentId: row.agentId,
  namespace: row.namespace,
  label: row.label,
  tokenPrefix: row.tokenPrefix,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  revokedAt: row.revokedAt,
});
