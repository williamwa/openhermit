import type { PrismaClient } from '../generated/prisma/index.js';

import type { UserStore } from '../interfaces.js';
import type { StoreScope, UserAgentRecord, UserIdentity, UserRecord, UserRole } from '../types.js';

export class DbUserStore implements UserStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(user: UserRecord): Promise<void> {
    await this.prisma.user.upsert({
      where: { userId: user.userId },
      create: {
        userId: user.userId,
        name: user.name ?? null,
        mergedInto: user.mergedInto ?? null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      update: {
        name: user.name ?? null,
        mergedInto: user.mergedInto ?? null,
        updatedAt: user.updatedAt,
      },
    });
  }

  async get(userId: string): Promise<UserRecord | undefined> {
    const row = await this.prisma.user.findFirst({
      where: { userId, mergedInto: null },
    });
    if (!row) return undefined;
    return this.rowToUserRecord(row);
  }

  async list(): Promise<UserRecord[]> {
    const rows = await this.prisma.user.findMany({
      where: { mergedInto: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.rowToUserRecord(row));
  }

  async linkIdentity(identity: UserIdentity): Promise<void> {
    const previous = await this.prisma.userIdentity.findUnique({
      where: {
        channel_channelUserId: {
          channel: identity.channel,
          channelUserId: identity.channelUserId,
        },
      },
    });
    const previousUserId = previous?.userId;

    await this.prisma.userIdentity.upsert({
      where: {
        channel_channelUserId: {
          channel: identity.channel,
          channelUserId: identity.channelUserId,
        },
      },
      create: {
        userId: identity.userId,
        channel: identity.channel,
        channelUserId: identity.channelUserId,
        createdAt: identity.createdAt,
      },
      update: {
        userId: identity.userId,
      },
    });

    if (previousUserId && previousUserId !== identity.userId) {
      await this.cleanupOrphanedUser(previousUserId, identity.userId);
    }
  }

  async resolve(channel: string, channelUserId: string): Promise<string | undefined> {
    const identity = await this.prisma.userIdentity.findUnique({
      where: {
        channel_channelUserId: { channel, channelUserId },
      },
      include: { user: true },
    });

    if (!identity) return undefined;

    if (typeof identity.user.mergedInto === 'string') {
      return identity.user.mergedInto;
    }

    return identity.userId;
  }

  async unlinkIdentity(channel: string, channelUserId: string): Promise<void> {
    await this.prisma.userIdentity.deleteMany({
      where: { channel, channelUserId },
    });
  }

  async listIdentities(userId: string): Promise<UserIdentity[]> {
    const rows = await this.prisma.userIdentity.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      channel: row.channel,
      channelUserId: row.channelUserId,
      createdAt: row.createdAt,
    }));
  }

  async merge(fromUserId: string, intoUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Re-link all identities from source to target
      await tx.userIdentity.updateMany({
        where: { userId: fromUserId },
        data: { userId: intoUserId },
      });

      // Re-assign agent roles: move UserAgent records (skip conflicts)
      const fromAgents = await tx.userAgent.findMany({ where: { userId: fromUserId } });
      for (const ua of fromAgents) {
        const exists = await tx.userAgent.findUnique({
          where: { userId_agentId: { userId: intoUserId, agentId: ua.agentId } },
        });
        if (!exists) {
          await tx.userAgent.create({
            data: { userId: intoUserId, agentId: ua.agentId, role: ua.role, createdAt: ua.createdAt },
          });
        }
      }
      await tx.userAgent.deleteMany({ where: { userId: fromUserId } });

      // Reassign session events
      await tx.sessionEvent.updateMany({
        where: { userId: fromUserId },
        data: { userId: intoUserId },
      });

      // Delete the merged user
      await tx.user.delete({ where: { userId: fromUserId } });
    });
  }

  async delete(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { userId } });
  }

  // ── Agent role methods ───────────────────────────────────────────────

  async assignAgent(scope: StoreScope, userId: string, role: UserRole, createdAt: string): Promise<void> {
    await this.prisma.userAgent.upsert({
      where: { userId_agentId: { userId, agentId: scope.agentId } },
      create: { userId, agentId: scope.agentId, role, createdAt },
      update: { role },
    });
  }

  async getAgentRole(scope: StoreScope, userId: string): Promise<UserRole | undefined> {
    const row = await this.prisma.userAgent.findUnique({
      where: { userId_agentId: { userId, agentId: scope.agentId } },
    });
    return row ? (row.role as UserRole) : undefined;
  }

  async listByAgent(scope: StoreScope): Promise<UserAgentRecord[]> {
    const rows = await this.prisma.userAgent.findMany({
      where: { agentId: scope.agentId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      userId: row.userId,
      agentId: row.agentId,
      role: row.role as UserRole,
      createdAt: row.createdAt,
    }));
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async cleanupOrphanedUser(orphanUserId: string, newUserId: string): Promise<void> {
    const remaining = await this.prisma.userIdentity.count({
      where: { userId: orphanUserId },
    });
    if (remaining > 0) return;

    await this.prisma.sessionEvent.updateMany({
      where: { userId: orphanUserId },
      data: { userId: newUserId },
    });

    await this.prisma.user.delete({ where: { userId: orphanUserId } });
  }

  private rowToUserRecord(row: {
    userId: string;
    name: string | null;
    mergedInto: string | null;
    createdAt: string;
    updatedAt: string;
  }): UserRecord {
    const record: UserRecord = {
      userId: row.userId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (row.name !== null) record.name = row.name;
    if (row.mergedInto !== null) record.mergedInto = row.mergedInto;
    return record;
  }
}
