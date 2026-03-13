import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { internalStateFiles } from '@openhermit/shared';

import { initializeInternalStateDatabase } from '../src/internal-state/sqlite.js';
import { createSecurityFixture } from './helpers.js';

test('initializeInternalStateDatabase bootstraps per-agent state.sqlite with schema version', async (t) => {
  const { security } = await createSecurityFixture(t);

  const database = initializeInternalStateDatabase(security.stateFilePath);

  try {
    assert.equal(database.databasePath, security.stateFilePath);
    assert.equal(database.getSchemaVersion(), 1);
    assert.equal(existsSync(security.stateFilePath), true);
  } finally {
    database.close();
  }
});

test('AgentSecurity exposes per-agent internal state paths outside the workspace', async (t) => {
  const { security, root } = await createSecurityFixture(t);

  assert.match(security.stateFilePath, new RegExp(`${internalStateFiles.sqlite.replace('.', '\\.')}$`));
  assert.match(security.runtimeFilePath, new RegExp(`${internalStateFiles.runtime.replace('.', '\\.')}$`));
  assert.equal(security.stateFilePath.startsWith(root), false);
  assert.equal(security.runtimeFilePath.startsWith(root), false);
});
