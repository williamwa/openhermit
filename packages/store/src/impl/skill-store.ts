import { PrismaClient } from '../generated/prisma/index.js';

import type { SkillStore } from '../interfaces.js';
import type { AgentSkillRecord, SkillRecord } from '../types.js';

export class DbSkillStore implements SkillStore {
  constructor(private readonly prisma: PrismaClient) {}

  static async open(databaseUrl?: string): Promise<DbSkillStore> {
    const url = databaseUrl ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    const prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    return new DbSkillStore(prisma);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async upsert(skill: SkillRecord): Promise<void> {
    const data = {
      name: skill.name,
      description: skill.description,
      path: skill.path,
      metadataJson: JSON.stringify(skill.metadata ?? {}),
      createdAt: skill.createdAt,
      updatedAt: skill.updatedAt,
    };

    await this.prisma.skill.upsert({
      where: { id: skill.id },
      create: { id: skill.id, ...data },
      update: data,
    });
  }

  async get(id: string): Promise<SkillRecord | undefined> {
    const row = await this.prisma.skill.findUnique({ where: { id } });
    if (!row) return undefined;
    return this.rowToRecord(row);
  }

  async list(): Promise<SkillRecord[]> {
    const rows = await this.prisma.skill.findMany({ orderBy: { name: 'asc' } });
    return rows.map((r) => this.rowToRecord(r));
  }

  async delete(id: string): Promise<void> {
    await this.prisma.skill.delete({ where: { id } }).catch(() => undefined);
  }

  async enable(agentId: string, skillId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.prisma.agentSkill.upsert({
      where: { agentId_skillId: { agentId, skillId } },
      create: { agentId, skillId, enabled: true, createdAt: now },
      update: { enabled: true },
    });
  }

  async disable(agentId: string, skillId: string): Promise<void> {
    await this.prisma.agentSkill.update({
      where: { agentId_skillId: { agentId, skillId } },
      data: { enabled: false },
    }).catch(() => undefined);
  }

  async listEnabled(agentId: string): Promise<SkillRecord[]> {
    const rows = await this.prisma.agentSkill.findMany({
      where: {
        agentId: { in: [agentId, '*'] },
        enabled: true,
      },
      include: { skill: true },
    });

    // Dedup: if both '*' and specific agentId exist for the same skill,
    // the specific assignment takes precedence (but both are enabled here).
    const seen = new Set<string>();
    const skills: SkillRecord[] = [];
    for (const row of rows) {
      if (!seen.has(row.skillId)) {
        seen.add(row.skillId);
        skills.push(this.rowToRecord(row.skill));
      }
    }

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listAssignments(skillId?: string): Promise<AgentSkillRecord[]> {
    const rows = await this.prisma.agentSkill.findMany({
      ...(skillId ? { where: { skillId } } : {}),
    });
    return rows.map((r) => ({
      agentId: r.agentId,
      skillId: r.skillId,
      enabled: r.enabled,
      createdAt: r.createdAt,
    }));
  }

  private rowToRecord(row: {
    id: string;
    name: string;
    description: string;
    path: string;
    metadataJson: string;
    createdAt: string;
    updatedAt: string;
  }): SkillRecord {
    const metadata = JSON.parse(row.metadataJson || '{}') as Record<string, unknown>;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      path: row.path,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
