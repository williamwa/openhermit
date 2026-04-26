import crypto from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, eq } from 'drizzle-orm';
import pg from 'pg';

import type { SecretStore } from '../interfaces.js';
import * as schema from '../schema.js';
import { agentSecrets } from '../schema.js';
import type { DrizzleDb } from './index.js';

/**
 * Encrypt secrets at rest using AES-256-GCM. The 32-byte key is supplied
 * via the OPENHERMIT_SECRETS_KEY environment variable, base64-encoded.
 *
 * Wire format stored in `agent_secrets.value_ciphertext`:
 *   base64(iv) ":" base64(authTag) ":" base64(ciphertext)
 *
 * The IV is freshly random per write — never reuse one with the same key.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

const decodeKey = (raw: string): Buffer => {
  // Accept both base64 and base64url; strip whitespace.
  const cleaned = raw.trim().replace(/\s+/gu, '');
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `OPENHERMIT_SECRETS_KEY must decode to ${KEY_LEN} bytes (got ${buf.length}). ` +
      `Generate with: node -e "console.log(require('crypto').randomBytes(${KEY_LEN}).toString('base64'))"`,
    );
  }
  return buf;
};

const encrypt = (key: Buffer, plaintext: string): string => {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
};

const decrypt = (key: Buffer, payload: string): string => {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('malformed secret ciphertext');
  const [iv, authTag, ciphertext] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return out.toString('utf8');
};

export const generateSecretsKey = (): string =>
  crypto.randomBytes(KEY_LEN).toString('base64');

export class DbSecretStore implements SecretStore {
  private pool?: pg.Pool;

  private constructor(
    private readonly db: DrizzleDb,
    private readonly key: Buffer,
  ) {}

  /** Read OPENHERMIT_SECRETS_KEY from env. Throws if missing or malformed. */
  static keyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
    const raw = env.OPENHERMIT_SECRETS_KEY;
    if (!raw) {
      throw new Error(
        'OPENHERMIT_SECRETS_KEY is not set. Run `hermit setup` to generate one, ' +
        'or set it manually with: ' +
        `node -e "console.log(require('crypto').randomBytes(${KEY_LEN}).toString('base64'))"`,
      );
    }
    return decodeKey(raw);
  }

  static async open(databaseUrl?: string): Promise<DbSecretStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is required');
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbSecretStore(db, DbSecretStore.keyFromEnv());
    store.pool = pool;
    return store;
  }

  static withDb(db: DrizzleDb): DbSecretStore {
    return new DbSecretStore(db, DbSecretStore.keyFromEnv());
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async list(agentId: string): Promise<Record<string, string>> {
    const rows = await this.db.select().from(agentSecrets)
      .where(eq(agentSecrets.agentId, agentId))
      .orderBy(asc(agentSecrets.name));
    const out: Record<string, string> = {};
    for (const row of rows) {
      try {
        out[row.name] = decrypt(this.key, row.valueCiphertext);
      } catch {
        // Decryption failure — usually means the key changed. Skip the
        // entry rather than crash the whole list (admin can rotate /
        // re-set the secret manually).
      }
    }
    return out;
  }

  async get(agentId: string, name: string): Promise<string | undefined> {
    const [row] = await this.db.select().from(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)));
    if (!row) return undefined;
    try {
      return decrypt(this.key, row.valueCiphertext);
    } catch {
      return undefined;
    }
  }

  async set(agentId: string, name: string, value: string): Promise<void> {
    const ciphertext = encrypt(this.key, value);
    const now = new Date().toISOString();
    await this.db.insert(agentSecrets)
      .values({ agentId, name, valueCiphertext: ciphertext, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [agentSecrets.agentId, agentSecrets.name],
        set: { valueCiphertext: ciphertext, updatedAt: now },
      });
  }

  async delete(agentId: string, name: string): Promise<void> {
    await this.db.delete(agentSecrets)
      .where(and(eq(agentSecrets.agentId, agentId), eq(agentSecrets.name, name)));
  }

  async setAll(agentId: string, secrets: Record<string, string>): Promise<void> {
    // Bulk replace: clear existing, then insert fresh ciphertexts. Simple
    // and correct; if you need atomic-ish behavior across replicas this
    // could move into a transaction.
    await this.db.delete(agentSecrets).where(eq(agentSecrets.agentId, agentId));
    if (Object.keys(secrets).length === 0) return;
    const now = new Date().toISOString();
    const rows = Object.entries(secrets).map(([name, value]) => ({
      agentId,
      name,
      valueCiphertext: encrypt(this.key, value),
      createdAt: now,
      updatedAt: now,
    }));
    await this.db.insert(agentSecrets).values(rows);
  }
}
