import { PrismaClient } from '../generated/prisma/index.js';
import type { InternalStateStore } from '../interfaces.js';
import { DbSessionStore } from './session-store.js';
import { DbMessageStore } from './message-store.js';
import { DbMemoryProvider } from './memory-provider.js';
import { DbContainerStore } from './container-store.js';
import { DbInstructionStore } from './instruction-store.js';
import { DbUserStore } from './user-store.js';
import { DbAgentStore } from './agent-store.js';

export class DbInternalStateStore implements InternalStateStore {
  readonly sessions: DbSessionStore;
  readonly messages: DbMessageStore;
  readonly memories: DbMemoryProvider;
  readonly containers: DbContainerStore;
  readonly instructions: DbInstructionStore;
  readonly users: DbUserStore;

  private constructor(private readonly prisma: PrismaClient) {
    this.sessions = new DbSessionStore(prisma);
    this.messages = new DbMessageStore(prisma);
    this.memories = new DbMemoryProvider(prisma);
    this.containers = new DbContainerStore(prisma);
    this.instructions = new DbInstructionStore(prisma);
    this.users = new DbUserStore(prisma);
  }

  static async open(databaseUrl?: string): Promise<DbInternalStateStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    const prisma = new PrismaClient({ datasourceUrl: url });

    try {
      await prisma.$connect();
      return new DbInternalStateStore(prisma);
    } catch (error) {
      await prisma.$disconnect();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

export { DbSessionStore } from './session-store.js';
export { DbMessageStore } from './message-store.js';
export { DbMemoryProvider } from './memory-provider.js';
export { DbContainerStore } from './container-store.js';
export { DbInstructionStore } from './instruction-store.js';
export { DbUserStore } from './user-store.js';
export { DbAgentStore } from './agent-store.js';
export { DbSkillStore } from './skill-store.js';
