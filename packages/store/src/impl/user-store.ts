import { eq, and, asc, isNull, sql } from 'drizzle-orm';

import type { UserStore } from '../interfaces.js';
import type { StoreScope, UserAgentRecord, UserIdentity, UserRecord, UserRole } from '../types.js';
import { users, userAgents, userIdentities, sessionEvents } from '../schema.js';
import type { DrizzleDb } from './index.js';

export class DbUserStore implements UserStore {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(user: UserRecord): Promise<void> {
    await this.db.insert(users).values({
      userId: user.userId,
      name: user.name ?? null,
      mergedInto: user.mergedInto ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }).onConflictDoUpdate({
      target: users.userId,
      set: {
        name: user.name ?? null,
        mergedInto: user.mergedInto ?? null,
        updatedAt: user.updatedAt,
      },
    });
  }

  async get(userId: string): Promise<UserRecord | undefined> {
    const [row] = await this.db.select().from(users)
      .where(and(eq(users.userId, userId), isNull(users.mergedInto)));
    if (!row) return undefined;
    return this.rowToUserRecord(row);
  }

  async list(): Promise<UserRecord[]> {
    const rows = await this.db.select().from(users)
      .where(isNull(users.mergedInto))
      .orderBy(asc(users.createdAt));
    return rows.map((row) => this.rowToUserRecord(row));
  }

  async linkIdentity(identity: UserIdentity): Promise<void> {
    const [previous] = await this.db.select().from(userIdentities)
      .where(and(
        eq(userIdentities.channel, identity.channel),
        eq(userIdentities.channelUserId, identity.channelUserId),
      ));
    const previousUserId = previous?.userId;

    await this.db.insert(userIdentities).values({
      userId: identity.userId,
      channel: identity.channel,
      channelUserId: identity.channelUserId,
      createdAt: identity.createdAt,
    }).onConflictDoUpdate({
      target: [userIdentities.channel, userIdentities.channelUserId],
      set: { userId: identity.userId },
    });

    if (previousUserId && previousUserId !== identity.userId) {
      await this.cleanupOrphanedUser(previousUserId, identity.userId);
    }
  }

  async resolve(channel: string, channelUserId: string): Promise<string | undefined> {
    const [identity] = await this.db.select({
      userId: userIdentities.userId,
      mergedInto: users.mergedInto,
    }).from(userIdentities)
      .innerJoin(users, eq(userIdentities.userId, users.userId))
      .where(and(
        eq(userIdentities.channel, channel),
        eq(userIdentities.channelUserId, channelUserId),
      ));

    if (!identity) return undefined;
    return typeof identity.mergedInto === 'string' ? identity.mergedInto : identity.userId;
  }

  async unlinkIdentity(channel: string, channelUserId: string): Promise<void> {
    await this.db.delete(userIdentities)
      .where(and(eq(userIdentities.channel, channel), eq(userIdentities.channelUserId, channelUserId)));
  }

  async listIdentities(userId: string): Promise<UserIdentity[]> {
    const rows = await this.db.select().from(userIdentities)
      .where(eq(userIdentities.userId, userId))
      .orderBy(asc(userIdentities.createdAt));
    return rows.map((row) => ({
      userId: row.userId,
      channel: row.channel,
      channelUserId: row.channelUserId,
      createdAt: row.createdAt,
    }));
  }

  async merge(fromUserId: string, intoUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(userIdentities).set({ userId: intoUserId })
        .where(eq(userIdentities.userId, fromUserId));

      const fromAgents = await tx.select().from(userAgents)
        .where(eq(userAgents.userId, fromUserId));
      for (const ua of fromAgents) {
        const [exists] = await tx.select().from(userAgents)
          .where(and(eq(userAgents.userId, intoUserId), eq(userAgents.agentId, ua.agentId)));
        if (!exists) {
          await tx.insert(userAgents).values({
            userId: intoUserId,
            agentId: ua.agentId,
            role: ua.role,
            createdAt: ua.createdAt,
          });
        }
      }
      await tx.delete(userAgents).where(eq(userAgents.userId, fromUserId));

      await tx.update(sessionEvents).set({ userId: intoUserId })
        .where(eq(sessionEvents.userId, fromUserId));

      await tx.delete(users).where(eq(users.userId, fromUserId));
    });
  }

  async delete(userId: string): Promise<void> {
    await this.db.delete(users).where(eq(users.userId, userId));
  }

  async assignAgent(scope: StoreScope, userId: string, role: UserRole, createdAt: string): Promise<void> {
    await this.db.insert(userAgents)
      .values({ userId, agentId: scope.agentId, role, createdAt })
      .onConflictDoUpdate({
        target: [userAgents.userId, userAgents.agentId],
        set: { role },
      });
  }

  async getAgentRole(scope: StoreScope, userId: string): Promise<UserRole | undefined> {
    const [row] = await this.db.select().from(userAgents)
      .where(and(eq(userAgents.userId, userId), eq(userAgents.agentId, scope.agentId)));
    return row ? (row.role as UserRole) : undefined;
  }

  async listByAgent(scope: StoreScope): Promise<UserAgentRecord[]> {
    const rows = await this.db.select().from(userAgents)
      .where(eq(userAgents.agentId, scope.agentId))
      .orderBy(asc(userAgents.createdAt));
    return rows.map((row) => ({
      userId: row.userId,
      agentId: row.agentId,
      role: row.role as UserRole,
      createdAt: row.createdAt,
    }));
  }

  private async cleanupOrphanedUser(orphanUserId: string, newUserId: string): Promise<void> {
    const [row] = await this.db.select({ count: sql<number>`count(*)::int` }).from(userIdentities)
      .where(eq(userIdentities.userId, orphanUserId));
    if ((row?.count ?? 0) > 0) return;

    await this.db.update(sessionEvents).set({ userId: newUserId })
      .where(eq(sessionEvents.userId, orphanUserId));
    await this.db.delete(users).where(eq(users.userId, orphanUserId));
  }

  private rowToUserRecord(row: typeof users.$inferSelect): UserRecord {
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
