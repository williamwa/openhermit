import type { DatabaseSync } from 'node:sqlite';

import type { UserStore } from '../interfaces.js';
import type { StoreScope, UserIdentity, UserRecord } from '../types.js';

export class SqliteUserStore implements UserStore {
  private writeQueue = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  async upsert(scope: StoreScope, user: UserRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      this.database
        .prepare(
          `INSERT INTO users(agent_id, user_id, role, name, merged_into, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, user_id) DO UPDATE SET
             role = excluded.role,
             name = excluded.name,
             merged_into = excluded.merged_into,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope.agentId,
          user.userId,
          user.role,
          user.name ?? null,
          user.mergedInto ?? null,
          user.createdAt,
          user.updatedAt,
        );
    });
  }

  async get(scope: StoreScope, userId: string): Promise<UserRecord | undefined> {
    const row = this.database
      .prepare(
        `SELECT user_id, role, name, merged_into, created_at, updated_at
         FROM users
         WHERE agent_id = ? AND user_id = ? AND merged_into IS NULL`,
      )
      .get(scope.agentId, userId) as Record<string, unknown> | undefined;

    if (!row) return undefined;
    return this.rowToUserRecord(row);
  }

  async list(scope: StoreScope): Promise<UserRecord[]> {
    const rows = this.database
      .prepare(
        `SELECT user_id, role, name, merged_into, created_at, updated_at
         FROM users
         WHERE agent_id = ? AND merged_into IS NULL
         ORDER BY created_at ASC`,
      )
      .all(scope.agentId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToUserRecord(row));
  }

  async linkIdentity(scope: StoreScope, identity: UserIdentity): Promise<void> {
    await this.enqueueWrite(async () => {
      this.database
        .prepare(
          `INSERT INTO user_identities(agent_id, user_id, channel, channel_user_id, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, channel, channel_user_id) DO UPDATE SET
             user_id = excluded.user_id`,
        )
        .run(
          scope.agentId,
          identity.userId,
          identity.channel,
          identity.channelUserId,
          identity.createdAt,
        );
    });
  }

  async resolve(scope: StoreScope, channel: string, channelUserId: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `SELECT ui.user_id, u.merged_into
         FROM user_identities ui
         JOIN users u ON u.agent_id = ui.agent_id AND u.user_id = ui.user_id
         WHERE ui.agent_id = ? AND ui.channel = ? AND ui.channel_user_id = ?`,
      )
      .get(scope.agentId, channel, channelUserId) as Record<string, unknown> | undefined;

    if (!row) return undefined;

    // Follow merged_into chain (at most one hop in practice)
    const mergedInto = row.merged_into;
    if (typeof mergedInto === 'string') {
      return mergedInto;
    }

    return String(row.user_id);
  }

  async unlinkIdentity(scope: StoreScope, channel: string, channelUserId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      this.database
        .prepare(
          `DELETE FROM user_identities
           WHERE agent_id = ? AND channel = ? AND channel_user_id = ?`,
        )
        .run(scope.agentId, channel, channelUserId);
    });
  }

  async listIdentities(scope: StoreScope, userId: string): Promise<UserIdentity[]> {
    const rows = this.database
      .prepare(
        `SELECT user_id, channel, channel_user_id, created_at
         FROM user_identities
         WHERE agent_id = ? AND user_id = ?
         ORDER BY created_at ASC`,
      )
      .all(scope.agentId, userId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      userId: String(row.user_id),
      channel: String(row.channel),
      channelUserId: String(row.channel_user_id),
      createdAt: String(row.created_at),
    }));
  }

  async merge(scope: StoreScope, fromUserId: string, intoUserId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      // Re-link all identities from source to target
      this.database
        .prepare(
          `UPDATE user_identities SET user_id = ?
           WHERE agent_id = ? AND user_id = ?`,
        )
        .run(intoUserId, scope.agentId, fromUserId);

      // Mark source as merged
      const now = new Date().toISOString();
      this.database
        .prepare(
          `UPDATE users SET merged_into = ?, updated_at = ?
           WHERE agent_id = ? AND user_id = ?`,
        )
        .run(intoUserId, now, scope.agentId, fromUserId);
    });
  }

  async delete(scope: StoreScope, userId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      // Identities are cascade-deleted via FK
      this.database
        .prepare(`DELETE FROM users WHERE agent_id = ? AND user_id = ?`)
        .run(scope.agentId, userId);
    });
  }

  private async enqueueWrite(work: () => Promise<void>): Promise<void> {
    const run = this.writeQueue.then(work, work);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }

  private rowToUserRecord(row: Record<string, unknown>): UserRecord {
    const record: UserRecord = {
      userId: String(row.user_id),
      role: String(row.role) as UserRecord['role'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };

    if (typeof row.name === 'string') {
      record.name = row.name;
    }

    if (typeof row.merged_into === 'string') {
      record.mergedInto = row.merged_into;
    }

    return record;
  }
}
