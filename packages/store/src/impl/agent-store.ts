import { PrismaClient } from '../generated/prisma/index.js';
import type { AgentStore } from '../interfaces.js';
import type { AgentRecord } from '../types.js';

export class DbAgentStore implements AgentStore {
  private constructor(private readonly prisma: PrismaClient) {}

  static async open(databaseUrl?: string): Promise<DbAgentStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    return new DbAgentStore(prisma);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async create(agent: AgentRecord): Promise<AgentRecord> {
    const row = await this.prisma.agent.create({
      data: {
        agentId: agent.agentId,
        name: agent.name ?? null,
        configDir: agent.configDir,
        workspaceDir: agent.workspaceDir,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      },
    });
    return this.toRecord(row);
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    const row = await this.prisma.agent.findUnique({
      where: { agentId },
    });
    return row ? this.toRecord(row) : undefined;
  }

  async list(): Promise<AgentRecord[]> {
    const rows = await this.prisma.agent.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.toRecord(row));
  }

  async update(
    agentId: string,
    patch: Partial<Pick<AgentRecord, 'name' | 'configDir' | 'workspaceDir'>>,
  ): Promise<AgentRecord | undefined> {
    try {
      const row = await this.prisma.agent.update({
        where: { agentId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name ?? null } : {}),
          ...(patch.configDir !== undefined ? { configDir: patch.configDir } : {}),
          ...(patch.workspaceDir !== undefined ? { workspaceDir: patch.workspaceDir } : {}),
          updatedAt: new Date().toISOString(),
        },
      });
      return this.toRecord(row);
    } catch {
      return undefined;
    }
  }

  async seedInstructions(
    agentId: string,
    entries: Array<{ key: string; content: string }>,
    updatedAt: string,
  ): Promise<void> {
    await this.prisma.instruction.createMany({
      data: entries.map((e) => ({
        agentId,
        key: e.key,
        content: e.content,
        updatedAt,
      })),
      skipDuplicates: true,
    });
  }

  async counts(): Promise<{ users: number; sessions: number; sessionEvents: number }> {
    const [users, sessions, sessionEvents] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.session.count(),
      this.prisma.sessionEvent.count(),
    ]);
    return { users, sessions, sessionEvents };
  }

  async delete(agentId: string): Promise<void> {
    await this.prisma.agent.deleteMany({ where: { agentId } });
  }

  private toRecord(row: {
    agentId: string;
    name: string | null;
    configDir: string;
    workspaceDir: string;
    createdAt: string;
    updatedAt: string;
  }): AgentRecord {
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
