import { eq, and, asc } from 'drizzle-orm';

import type { InstructionStore } from '../interfaces.js';
import type { InstructionEntry, StoreScope } from '../types.js';
import { instructions } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbInstructionStore implements InstructionStore {
  constructor(private readonly db: DrizzleDb) {}

  async get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined> {
    const [row] = await this.db.select().from(instructions)
      .where(and(eq(instructions.agentId, scope.agentId), eq(instructions.key, key)));
    if (!row) return undefined;
    return { key: row.key, content: row.content, updatedAt: row.updatedAt };
  }

  async getAll(scope: StoreScope): Promise<InstructionEntry[]> {
    const rows = await this.db.select().from(instructions)
      .where(eq(instructions.agentId, scope.agentId))
      .orderBy(asc(instructions.key));
    return rows.map((row) => ({ key: row.key, content: row.content, updatedAt: row.updatedAt }));
  }

  async set(scope: StoreScope, key: string, content: string, updatedAt: string): Promise<void> {
    await this.db.insert(instructions)
      .values({ agentId: scope.agentId, key, content, updatedAt })
      .onConflictDoUpdate({
        target: [instructions.agentId, instructions.key],
        set: { content, updatedAt },
      });
  }
}
