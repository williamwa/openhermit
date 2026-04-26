import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import pg from 'pg';

import type { AgentConfigStore } from '../interfaces.js';
import * as schema from '../schema.js';
import { agents } from '../schema.js';
import type { DrizzleDb } from './index.js';

/**
 * Walk a dot-path into a record. Returns undefined if any segment
 * is missing or the parent is not an object.
 */
const readPath = (doc: Record<string, unknown> | null, dotPath: string): unknown => {
  if (!doc) return undefined;
  const segments = dotPath.split('.').filter(Boolean);
  let cursor: unknown = doc;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
};

/**
 * Write a value at a dot-path inside a record, returning a new
 * top-level object. Creates missing intermediate objects.
 */
const writePath = (
  doc: Record<string, unknown> | null,
  dotPath: string,
  value: unknown,
): Record<string, unknown> => {
  const root: Record<string, unknown> = doc ? { ...doc } : {};
  const segments = dotPath.split('.').filter(Boolean);
  if (segments.length === 0) {
    if (value === null || typeof value !== 'object') {
      throw new Error('Cannot set the entire config document with setConfigPath; use setConfig.');
    }
    return value as Record<string, unknown>;
  }
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cursor[seg];
    if (next === undefined || next === null || typeof next !== 'object') {
      const created: Record<string, unknown> = {};
      cursor[seg] = created;
      cursor = created;
    } else {
      const cloned = { ...(next as Record<string, unknown>) };
      cursor[seg] = cloned;
      cursor = cloned;
    }
  }
  cursor[segments[segments.length - 1]!] = value;
  return root;
};

const parseJsonOrNull = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export class DbAgentConfigStore implements AgentConfigStore {
  private pool?: pg.Pool;

  constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbAgentConfigStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAgentConfigStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async getConfig(agentId: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db.select({ configJson: agents.configJson })
      .from(agents).where(eq(agents.agentId, agentId));
    return parseJsonOrNull(row?.configJson ?? null);
  }

  async setConfig(agentId: string, config: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(config);
    const updatedAt = new Date().toISOString();
    await this.db.update(agents)
      .set({ configJson: json, updatedAt })
      .where(eq(agents.agentId, agentId));
  }

  async getSecurity(agentId: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db.select({ securityJson: agents.securityJson })
      .from(agents).where(eq(agents.agentId, agentId));
    return parseJsonOrNull(row?.securityJson ?? null);
  }

  async setSecurity(agentId: string, policy: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(policy);
    const updatedAt = new Date().toISOString();
    await this.db.update(agents)
      .set({ securityJson: json, updatedAt })
      .where(eq(agents.agentId, agentId));
  }

  async getConfigPath(agentId: string, path: string): Promise<unknown> {
    return readPath(await this.getConfig(agentId), path);
  }

  async setConfigPath(agentId: string, path: string, value: unknown): Promise<void> {
    const current = await this.getConfig(agentId);
    const next = writePath(current, path, value);
    await this.setConfig(agentId, next);
  }

  async getSecurityPath(agentId: string, path: string): Promise<unknown> {
    return readPath(await this.getSecurity(agentId), path);
  }

  async setSecurityPath(agentId: string, path: string, value: unknown): Promise<void> {
    const current = await this.getSecurity(agentId);
    const next = writePath(current, path, value);
    await this.setSecurity(agentId, next);
  }
}
