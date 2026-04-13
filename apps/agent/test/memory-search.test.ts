import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { SqliteMemoryProvider, bootstrapDatabase } from '@openhermit/store';
import type { StoreScope } from '@openhermit/store';

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  bootstrapDatabase(db);
  return db;
}

const scope: StoreScope = { agentId: 'test-agent' };

test('memory search: multi-word query matches across key and content', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, {
    id: 'incident/anthropic-quota-2026-03',
    content: 'Anthropic raised API quota limits after the March 2026 incident affecting multiple customers.',
  });

  const results = await provider.search(scope, 'anthropic quota');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'incident/anthropic-quota-2026-03');

  db.close();
});

test('memory search: individual words match even when not adjacent', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, {
    id: 'project/api-redesign',
    content: 'The backend API needs a complete redesign for v2 launch.',
  });

  const results = await provider.search(scope, 'api redesign');
  assert.equal(results.length, 1);

  const results2 = await provider.search(scope, 'backend v2');
  assert.equal(results2.length, 1);

  db.close();
});

test('memory search: porter stemming matches word variants', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, {
    id: 'note/running',
    content: 'The deployment pipeline is running smoothly after the fix.',
  });

  // "runs" should match "running" via porter stemming
  const results = await provider.search(scope, 'runs');
  assert.equal(results.length, 1);

  db.close();
});

test('memory search: scoped to agent_id', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  const scope2: StoreScope = { agentId: 'other-agent' };

  await provider.add(scope, { id: 'shared-key', content: 'Agent 1 memory about deployment.' });
  await provider.add(scope2, { id: 'shared-key', content: 'Agent 2 memory about deployment.' });

  const results = await provider.search(scope, 'deployment');
  assert.equal(results.length, 1);
  assert.equal(results[0].content, 'Agent 1 memory about deployment.');

  db.close();
});

test('memory search: updated content is searchable', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, { id: 'evolving', content: 'Original content about databases.' });

  // Update with new content
  await provider.update(scope, 'evolving', { content: 'Updated content about kubernetes.' });

  // Old content should not match
  const old = await provider.search(scope, 'databases');
  assert.equal(old.length, 0);

  // New content should match
  const fresh = await provider.search(scope, 'kubernetes');
  assert.equal(fresh.length, 1);

  db.close();
});

test('memory search: deleted entries are not searchable', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, { id: 'temporary', content: 'This will be deleted soon.' });

  let results = await provider.search(scope, 'deleted');
  assert.equal(results.length, 1);

  await provider.delete(scope, 'temporary');

  results = await provider.search(scope, 'deleted');
  assert.equal(results.length, 0);

  db.close();
});

test('memory search: empty query returns empty results', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, { id: 'test', content: 'Some content.' });

  const results = await provider.search(scope, '   ');
  assert.equal(results.length, 0);

  db.close();
});

test('memory search: matches key tokens like slash-separated paths', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, {
    id: 'user/preferences/editor',
    content: 'User prefers vim keybindings.',
  });

  const results = await provider.search(scope, 'preferences editor');
  assert.equal(results.length, 1);

  const results2 = await provider.search(scope, 'user preferences');
  assert.equal(results2.length, 1);

  db.close();
});

test('memory search: respects limit parameter', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  for (let i = 0; i < 5; i++) {
    await provider.add(scope, { id: `note-${i}`, content: `Important note number ${i} about deployment.` });
  }

  const results = await provider.search(scope, 'deployment', { limit: 2 });
  assert.equal(results.length, 2);

  db.close();
});

test('memory search: re-add (upsert) updates FTS index', async () => {
  const db = createTestDb();
  const provider = new SqliteMemoryProvider(db);

  await provider.add(scope, { id: 'reused-key', content: 'Original about python.' });
  await provider.add(scope, { id: 'reused-key', content: 'Replaced with content about rust.' });

  const old = await provider.search(scope, 'python');
  assert.equal(old.length, 0);

  const fresh = await provider.search(scope, 'rust');
  assert.equal(fresh.length, 1);

  db.close();
});
