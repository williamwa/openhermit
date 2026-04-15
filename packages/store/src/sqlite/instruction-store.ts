import type { PrismaClient } from '../generated/prisma/index.js';

import type { InstructionStore } from '../interfaces.js';
import type { InstructionEntry, StoreScope } from '../types.js';

export class SqliteInstructionStore implements InstructionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async get(scope: StoreScope, key: string): Promise<InstructionEntry | undefined> {
    const row = await this.prisma.instruction.findUnique({
      where: { agentId_key: { agentId: scope.agentId, key } },
    });

    if (!row) return undefined;

    return {
      key: row.key,
      content: row.content,
      updatedAt: row.updatedAt,
    };
  }

  async getAll(scope: StoreScope): Promise<InstructionEntry[]> {
    const rows = await this.prisma.instruction.findMany({
      where: { agentId: scope.agentId },
      orderBy: { key: 'asc' },
    });

    return rows.map((row) => ({
      key: row.key,
      content: row.content,
      updatedAt: row.updatedAt,
    }));
  }

  async set(
    scope: StoreScope,
    key: string,
    content: string,
    updatedAt: string,
  ): Promise<void> {
    await this.prisma.instruction.upsert({
      where: { agentId_key: { agentId: scope.agentId, key } },
      create: { agentId: scope.agentId, key, content, updatedAt },
      update: { content, updatedAt },
    });
  }
}
