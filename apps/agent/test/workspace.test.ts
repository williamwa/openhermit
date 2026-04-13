import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { ValidationError } from '@openhermit/shared';

import { createWorkspaceFixture, createTempDir } from './helpers.js';

test('AgentWorkspace init scaffolds config and directories', async (t) => {
  const { root, workspace } = await createWorkspaceFixture(t);

  const config = await workspace.readConfig();
  const rootEntries = await fs.readdir(root);
  const openHermitEntries = await fs.readdir(path.join(root, '.openhermit'));

  assert.ok(config !== undefined);
  assert.ok(rootEntries.includes('.openhermit'));
  assert.ok(rootEntries.includes('containers'));
  assert.ok(openHermitEntries.includes('config.json'));
  assert.ok(!rootEntries.includes('files'));
  assert.ok(!rootEntries.includes('hooks'));
  assert.ok(!rootEntries.includes('logs'));
  assert.ok(!rootEntries.includes('memory'));
  assert.ok(!rootEntries.includes('sessions'));
  assert.ok(!rootEntries.includes('runtime'));
});


test('AgentWorkspace supports write and read', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);

  await workspace.writeFile('files/note.txt', 'hello workspace');
  assert.equal(await workspace.readFile('files/note.txt'), 'hello workspace');
});

test('AgentWorkspace rejects lexical path escapes', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);

  await assert.rejects(
    () => workspace.resolve('../escape.txt'),
    ValidationError,
  );
  await assert.rejects(
    () => workspace.writeFile('../escape.txt', 'blocked'),
    ValidationError,
  );
});

test('AgentWorkspace rejects symlink escapes for new files', async (t) => {
  const { root, workspace } = await createWorkspaceFixture(t);
  const outsideDir = await createTempDir(t, 'openhermit-outside-');
  await fs.mkdir(path.join(root, 'files'), { recursive: true });
  const linkPath = path.join(root, 'files', 'outside-link');

  await fs.symlink(outsideDir, linkPath);

  await assert.rejects(
    () => workspace.writeFile('files/outside-link/secret.txt', 'blocked'),
    ValidationError,
  );
});

test('AgentWorkspace surfaces config.json parse errors with the file path', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);

  await workspace.writeFile('.openhermit/config.json', '{\n  "channels": {\n  ]\n');

  await assert.rejects(
    () => workspace.readConfig(),
    /Invalid JSON in .*config\.json: .*line 3/i,
  );
});
