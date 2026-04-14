import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SqliteUserStore, bootstrapDatabase } from '@openhermit/store';
import type { StoreScope } from '@openhermit/store';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  bootstrapDatabase(db);
  return db;
}

const scope: StoreScope = { agentId: 'test-agent' };

test('UserStore: upsert and get a user', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, {
    userId: 'usr-001',
    role: 'owner',
    name: 'Alice',
    createdAt: now,
    updatedAt: now,
  });

  const user = await store.get(scope, 'usr-001');
  assert.ok(user);
  assert.equal(user.userId, 'usr-001');
  assert.equal(user.role, 'owner');
  assert.equal(user.name, 'Alice');

  db.close();
});

test('UserStore: upsert updates existing user', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, {
    userId: 'usr-001',
    role: 'guest',
    createdAt: now,
    updatedAt: now,
  });

  const later = new Date().toISOString();
  await store.upsert(scope, {
    userId: 'usr-001',
    role: 'user',
    name: 'Bob',
    createdAt: now,
    updatedAt: later,
  });

  const user = await store.get(scope, 'usr-001');
  assert.ok(user);
  assert.equal(user.role, 'user');
  assert.equal(user.name, 'Bob');

  db.close();
});

test('UserStore: list excludes merged users', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await store.upsert(scope, { userId: 'usr-003', role: 'user', mergedInto: 'usr-001', createdAt: now, updatedAt: now });

  const users = await store.list(scope);
  assert.equal(users.length, 2);
  assert.ok(users.find((u) => u.userId === 'usr-001'));
  assert.ok(users.find((u) => u.userId === 'usr-002'));
  assert.ok(!users.find((u) => u.userId === 'usr-003'));

  db.close();
});

test('UserStore: link and resolve identity', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope, {
    userId: 'usr-001',
    channel: 'telegram',
    channelUserId: '12345',
    createdAt: now,
  });

  const resolved = await store.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, 'usr-001');

  // Unknown identity returns undefined
  const unknown = await store.resolve(scope, 'telegram', '99999');
  assert.equal(unknown, undefined);

  db.close();
});

test('UserStore: resolve follows merged_into', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope, { userId: 'usr-002', channel: 'telegram', channelUserId: '12345', createdAt: now });

  // Merge usr-002 into usr-001
  await store.merge(scope, 'usr-002', 'usr-001');

  // Identity should now resolve to usr-001
  const resolved = await store.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, 'usr-001');

  db.close();
});

test('UserStore: merge re-links identities', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope, { userId: 'usr-002', channel: 'telegram', channelUserId: '111', createdAt: now });
  await store.linkIdentity(scope, { userId: 'usr-002', channel: 'discord', channelUserId: '222', createdAt: now });

  await store.merge(scope, 'usr-002', 'usr-001');

  // All identities should be on usr-001
  const identities = await store.listIdentities(scope, 'usr-001');
  assert.equal(identities.length, 2);
  assert.ok(identities.find((i) => i.channel === 'telegram' && i.channelUserId === '111'));
  assert.ok(identities.find((i) => i.channel === 'discord' && i.channelUserId === '222'));

  // usr-002 should have no identities
  const oldIdentities = await store.listIdentities(scope, 'usr-002');
  assert.equal(oldIdentities.length, 0);

  db.close();
});

test('UserStore: unlink identity', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope, { userId: 'usr-001', channel: 'telegram', channelUserId: '12345', createdAt: now });

  await store.unlinkIdentity(scope, 'telegram', '12345');

  const resolved = await store.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, undefined);

  db.close();
});

test('UserStore: delete cascades identities', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope, { userId: 'usr-001', channel: 'telegram', channelUserId: '12345', createdAt: now });

  await store.delete(scope, 'usr-001');

  const user = await store.get(scope, 'usr-001');
  assert.equal(user, undefined);

  const resolved = await store.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, undefined);

  db.close();
});

test('UserStore: linkIdentity re-links existing identity to new user', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  await store.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope, { userId: 'usr-002', channel: 'telegram', channelUserId: '12345', createdAt: now });

  // Re-link to usr-001
  await store.linkIdentity(scope, { userId: 'usr-001', channel: 'telegram', channelUserId: '12345', createdAt: now });

  const resolved = await store.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, 'usr-001');

  db.close();
});

test('UserStore: scope isolation between agents', async () => {
  const db = createTestDb();
  const store = new SqliteUserStore(db);

  const now = new Date().toISOString();
  const scope1: StoreScope = { agentId: 'agent-1' };
  const scope2: StoreScope = { agentId: 'agent-2' };

  await store.upsert(scope1, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await store.linkIdentity(scope1, { userId: 'usr-001', channel: 'cli', channelUserId: 'alice', createdAt: now });

  // Agent 2 should not see agent 1's user
  const user = await store.get(scope2, 'usr-001');
  assert.equal(user, undefined);

  const resolved = await store.resolve(scope2, 'cli', 'alice');
  assert.equal(resolved, undefined);

  db.close();
});
