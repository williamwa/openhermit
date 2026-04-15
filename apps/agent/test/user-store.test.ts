import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SqliteInternalStateStore } from '@openhermit/store';
import type { StoreScope, UserStore } from '@openhermit/store';

import { createTempDir } from './helpers.js';

async function createTestStore(t: import('node:test').TestContext) {
  const dir = await createTempDir(t, 'user-store-');
  return SqliteInternalStateStore.open(`${dir}/test.sqlite`);
}

const scope: StoreScope = { agentId: 'test-agent' };

test('UserStore: upsert and get a user', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, {
    userId: 'usr-001',
    role: 'owner',
    name: 'Alice',
    createdAt: now,
    updatedAt: now,
  });

  const user = await users.get(scope, 'usr-001');
  assert.ok(user);
  assert.equal(user.userId, 'usr-001');
  assert.equal(user.role, 'owner');
  assert.equal(user.name, 'Alice');
});

test('UserStore: upsert updates existing user', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, {
    userId: 'usr-001',
    role: 'guest',
    createdAt: now,
    updatedAt: now,
  });

  const later = new Date().toISOString();
  await users.upsert(scope, {
    userId: 'usr-001',
    role: 'user',
    name: 'Bob',
    createdAt: now,
    updatedAt: later,
  });

  const user = await users.get(scope, 'usr-001');
  assert.ok(user);
  assert.equal(user.role, 'user');
  assert.equal(user.name, 'Bob');
});

test('UserStore: list excludes merged users', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await users.upsert(scope, { userId: 'usr-003', role: 'user', mergedInto: 'usr-001', createdAt: now, updatedAt: now });

  const list = await users.list(scope);
  assert.equal(list.length, 2);
  assert.ok(list.find((u) => u.userId === 'usr-001'));
  assert.ok(list.find((u) => u.userId === 'usr-002'));
  assert.ok(!list.find((u) => u.userId === 'usr-003'));
});

test('UserStore: link and resolve identity', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope, {
    userId: 'usr-001',
    channel: 'telegram',
    channelUserId: '12345',
    createdAt: now,
  });

  const resolved = await users.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, 'usr-001');

  // Unknown identity returns undefined
  const unknown = await users.resolve(scope, 'telegram', '99999');
  assert.equal(unknown, undefined);
});

test('UserStore: resolve follows merged_into', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope, { userId: 'usr-002', channel: 'telegram', channelUserId: '12345', createdAt: now });

  // Merge usr-002 into usr-001
  await users.merge(scope, 'usr-002', 'usr-001');

  // Identity should now resolve to usr-001
  const resolved = await users.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, 'usr-001');
});

test('UserStore: merge re-links identities', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope, { userId: 'usr-002', channel: 'telegram', channelUserId: '111', createdAt: now });
  await users.linkIdentity(scope, { userId: 'usr-002', channel: 'discord', channelUserId: '222', createdAt: now });

  await users.merge(scope, 'usr-002', 'usr-001');

  // All identities should be on usr-001
  const identities = await users.listIdentities(scope, 'usr-001');
  assert.equal(identities.length, 2);
  assert.ok(identities.find((i) => i.channel === 'telegram' && i.channelUserId === '111'));
  assert.ok(identities.find((i) => i.channel === 'discord' && i.channelUserId === '222'));

  // usr-002 should have no identities
  const oldIdentities = await users.listIdentities(scope, 'usr-002');
  assert.equal(oldIdentities.length, 0);
});

test('UserStore: unlink identity', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope, { userId: 'usr-001', channel: 'telegram', channelUserId: '12345', createdAt: now });

  await users.unlinkIdentity(scope, 'telegram', '12345');

  const resolved = await users.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, undefined);
});

test('UserStore: delete cascades identities', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope, { userId: 'usr-001', channel: 'telegram', channelUserId: '12345', createdAt: now });

  await users.delete(scope, 'usr-001');

  const user = await users.get(scope, 'usr-001');
  assert.equal(user, undefined);

  const resolved = await users.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, undefined);
});

test('UserStore: linkIdentity re-links existing identity to new user', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  await users.upsert(scope, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.upsert(scope, { userId: 'usr-002', role: 'guest', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope, { userId: 'usr-002', channel: 'telegram', channelUserId: '12345', createdAt: now });

  // Re-link to usr-001
  await users.linkIdentity(scope, { userId: 'usr-001', channel: 'telegram', channelUserId: '12345', createdAt: now });

  const resolved = await users.resolve(scope, 'telegram', '12345');
  assert.equal(resolved, 'usr-001');
});

test('UserStore: scope isolation between agents', async (t) => {
  const store = await createTestStore(t);
  t.after(() => store.close());
  const users = store.users;

  const now = new Date().toISOString();
  const scope1: StoreScope = { agentId: 'agent-1' };
  const scope2: StoreScope = { agentId: 'agent-2' };

  await users.upsert(scope1, { userId: 'usr-001', role: 'owner', createdAt: now, updatedAt: now });
  await users.linkIdentity(scope1, { userId: 'usr-001', channel: 'cli', channelUserId: 'alice', createdAt: now });

  // Agent 2 should not see agent 1's user
  const user = await users.get(scope2, 'usr-001');
  assert.equal(user, undefined);

  const resolved = await users.resolve(scope2, 'cli', 'alice');
  assert.equal(resolved, undefined);
});
