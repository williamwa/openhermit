import type { PrismaClient } from '../generated/prisma/index.js';

import type { UserStore } from '../interfaces.js';
import type { StoreScope, UserIdentity, UserRecord } from '../types.js';

export class DbUserStore implements UserStore {
  constructor(private readonly prisma: PrismaClient) {}

  async upsert(scope: StoreScope, user: UserRecord): Promise<void> {
    await this.prisma.user.upsert({
      where: { agentId_userId: { agentId: scope.agentId, userId: user.userId } },
      create: {
        agentId: scope.agentId,
        userId: user.userId,
        role: user.role,
        name: user.name ?? null,
        mergedInto: user.mergedInto ?? null,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      update: {
        role: user.role,
        name: user.name ?? null,
        mergedInto: user.mergedInto ?? null,
        updatedAt: user.updatedAt,
      },
    });
  }

  async get(scope: StoreScope, userId: string): Promise<UserRecord | undefined> {
    const row = await this.prisma.user.findFirst({
      where: { agentId: scope.agentId, userId, mergedInto: null },
    });

    if (!row) return undefined;
    return this.rowToUserRecord(row);
  }

  async list(scope: StoreScope): Promise<UserRecord[]> {
    const rows = await this.prisma.user.findMany({
      where: { agentId: scope.agentId, mergedInto: null },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => this.rowToUserRecord(row));
  }

  async linkIdentity(scope: StoreScope, identity: UserIdentity): Promise<void> {
    // Find previous owner of this identity (if any)
    const previous = await this.prisma.userIdentity.findUnique({
      where: {
        agentId_channel_channelUserId: {
          agentId: scope.agentId,
          channel: identity.channel,
          channelUserId: identity.channelUserId,
        },
      },
    });
    const previousUserId = previous?.userId;

    // Upsert the identity link
    await this.prisma.userIdentity.upsert({
      where: {
        agentId_channel_channelUserId: {
          agentId: scope.agentId,
          channel: identity.channel,
          channelUserId: identity.channelUserId,
        },
      },
      create: {
        agentId: scope.agentId,
        userId: identity.userId,
        channel: identity.channel,
        channelUserId: identity.channelUserId,
        createdAt: identity.createdAt,
      },
      update: {
        userId: identity.userId,
      },
    });

    // If the identity moved from a different user, clean up the orphan
    if (previousUserId && previousUserId !== identity.userId) {
      await this.cleanupOrphanedUser(scope, previousUserId, identity.userId);
    }
  }

  async resolve(scope: StoreScope, channel: string, channelUserId: string): Promise<string | undefined> {
    const identity = await this.prisma.userIdentity.findUnique({
      where: {
        agentId_channel_channelUserId: {
          agentId: scope.agentId,
          channel,
          channelUserId,
        },
      },
      include: { user: true },
    });

    if (!identity) return undefined;

    // Follow merged_into chain (at most one hop in practice)
    if (typeof identity.user.mergedInto === 'string') {
      return identity.user.mergedInto;
    }

    return identity.userId;
  }

  async unlinkIdentity(scope: StoreScope, channel: string, channelUserId: string): Promise<void> {
    await this.prisma.userIdentity.deleteMany({
      where: { agentId: scope.agentId, channel, channelUserId },
    });
  }

  async listIdentities(scope: StoreScope, userId: string): Promise<UserIdentity[]> {
    const rows = await this.prisma.userIdentity.findMany({
      where: { agentId: scope.agentId, userId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      userId: row.userId,
      channel: row.channel,
      channelUserId: row.channelUserId,
      createdAt: row.createdAt,
    }));
  }

  async merge(scope: StoreScope, fromUserId: string, intoUserId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Re-link all identities from source to target
      await tx.userIdentity.updateMany({
        where: { agentId: scope.agentId, userId: fromUserId },
        data: { userId: intoUserId },
      });

      // Reassign session events from source to target
      await tx.sessionEvent.updateMany({
        where: { agentId: scope.agentId, userId: fromUserId },
        data: { userId: intoUserId },
      });

      // Delete the merged user (identities already moved, cascade won't lose anything)
      await tx.user.delete({
        where: { agentId_userId: { agentId: scope.agentId, userId: fromUserId } },
      });
    });
  }

  async delete(scope: StoreScope, userId: string): Promise<void> {
    // Identities are cascade-deleted via FK
    await this.prisma.user.delete({
      where: { agentId_userId: { agentId: scope.agentId, userId } },
    });
  }

  /**
   * After an identity is moved away from a user, check if that user has no
   * remaining identities. If so, reassign their session events and delete them.
   */
  private async cleanupOrphanedUser(
    scope: StoreScope,
    orphanUserId: string,
    newUserId: string,
  ): Promise<void> {
    const remaining = await this.prisma.userIdentity.count({
      where: { agentId: scope.agentId, userId: orphanUserId },
    });
    if (remaining > 0) return;

    // Reassign all session events from the orphan to the new owner
    await this.prisma.sessionEvent.updateMany({
      where: { agentId: scope.agentId, userId: orphanUserId },
      data: { userId: newUserId },
    });

    // Delete the orphaned user
    await this.prisma.user.delete({
      where: { agentId_userId: { agentId: scope.agentId, userId: orphanUserId } },
    });
  }

  private rowToUserRecord(row: {
    userId: string;
    role: string;
    name: string | null;
    mergedInto: string | null;
    createdAt: string;
    updatedAt: string;
  }): UserRecord {
    const record: UserRecord = {
      userId: row.userId,
      role: row.role as UserRecord['role'],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };

    if (row.name !== null) {
      record.name = row.name;
    }

    if (row.mergedInto !== null) {
      record.mergedInto = row.mergedInto;
    }

    return record;
  }
}
