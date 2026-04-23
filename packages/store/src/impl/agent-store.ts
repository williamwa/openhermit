import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';

import type { AgentStore } from '../interfaces.js';
import type { AgentRecord } from '../types.js';
import * as schema from '../schema.js';
import { agents, instructions, users, userAgents, sessions, sessionEvents } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbAgentStore implements AgentStore {
  private pool?: pg.Pool;

  private constructor(private readonly db: DrizzleDb) {}

  static async open(databaseUrl?: string): Promise<DbAgentStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const pool = new pg.Pool({ connectionString: url });
    await pool.query('SELECT 1');
    const db = drizzle(pool, { schema });
    const store = new DbAgentStore(db);
    store.pool = pool;
    return store;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async create(agent: AgentRecord): Promise<AgentRecord> {
    const [row] = await this.db.insert(agents).values({
      agentId: agent.agentId,
      name: agent.name ?? null,
      configDir: agent.configDir,
      workspaceDir: agent.workspaceDir,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    }).returning();
    return this.toRecord(row!);
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    const [row] = await this.db.select().from(agents).where(eq(agents.agentId, agentId));
    return row ? this.toRecord(row) : undefined;
  }

  async list(): Promise<AgentRecord[]> {
    const rows = await this.db.select().from(agents).orderBy(agents.createdAt);
    return rows.map((row) => this.toRecord(row));
  }

  async update(
    agentId: string,
    patch: Partial<Pick<AgentRecord, 'name' | 'configDir' | 'workspaceDir'>>,
  ): Promise<AgentRecord | undefined> {
    const data: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) data.name = patch.name ?? null;
    if (patch.configDir !== undefined) data.configDir = patch.configDir;
    if (patch.workspaceDir !== undefined) data.workspaceDir = patch.workspaceDir;

    const rows = await this.db.update(agents).set(data).where(eq(agents.agentId, agentId)).returning();
    return rows[0] ? this.toRecord(rows[0]) : undefined;
  }

  async seedInstructions(
    agentId: string,
    entries: Array<{ key: string; content: string }>,
    updatedAt: string,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.db.insert(instructions)
      .values(entries.map((e) => ({ agentId, key: e.key, content: e.content, updatedAt })))
      .onConflictDoNothing();
  }

  async assignOwner(agentId: string, userId: string, now: string): Promise<void> {
    await this.db.insert(users)
      .values({ userId, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    await this.db.insert(userAgents)
      .values({ userId, agentId, role: 'owner', createdAt: now })
      .onConflictDoUpdate({
        target: [userAgents.userId, userAgents.agentId],
        set: { role: 'owner' },
      });
  }

  async counts(): Promise<{ users: number; sessions: number; sessionEvents: number }> {
    const [[u], [s], [e]] = await Promise.all([
      this.db.select({ count: sql<number>`count(*)::int` }).from(users),
      this.db.select({ count: sql<number>`count(*)::int` }).from(sessions),
      this.db.select({ count: sql<number>`count(*)::int` }).from(sessionEvents),
    ]);
    return { users: u!.count, sessions: s!.count, sessionEvents: e!.count };
  }

  async delete(agentId: string): Promise<void> {
    await this.db.delete(agents).where(eq(agents.agentId, agentId));
  }

  private toRecord(row: typeof agents.$inferSelect): AgentRecord {
    return {
      agentId: row.agentId,
      ...(row.name ? { name: row.name } : {}),
      configDir: row.configDir,
      workspaceDir: row.workspaceDir,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
