import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { NotFoundError, ValidationError } from '@openhermit/shared';

import { createWorkspaceFixture, createTempDir } from './helpers.js';

test('AgentWorkspace init scaffolds config and identity files', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);

  const config = await workspace.readConfig();
  const identity = await workspace.readFile('identity/IDENTITY.md');
  const agentsInstructions = await workspace.readFile('identity/AGENTS.md');
  const longTerm = await workspace.readFile('memory/long-term.md');
  const sessionIndex = await workspace.readFile('sessions/index.json');
  const rootEntries = await workspace.listFiles('.');

  assert.equal(config.agent_id, 'agent-test');
  assert.equal(config.name, 'Test Agent');
  assert.match(identity, /Name: Test Agent/);
  assert.match(agentsInstructions, /workspace-specific instructions, preferences, and collaboration rules/);
  assert.doesNotMatch(agentsInstructions, /Container tool rules:/);
  assert.match(longTerm, /# Long-Term Memory/);
  assert.match(sessionIndex, /"version": 1/);
  assert.ok(rootEntries.some((entry) => entry.path === 'config.json'));
  assert.ok(rootEntries.some((entry) => entry.path === 'identity'));
  assert.ok(rootEntries.some((entry) => entry.path === 'memory'));
  assert.ok(rootEntries.some((entry) => entry.path === 'sessions'));
});

test('AgentWorkspace supports write, read, list, and delete', async (t) => {
  const { workspace } = await createWorkspaceFixture(t);

  await workspace.writeFile('files/note.txt', 'hello workspace');
  assert.equal(await workspace.readFile('files/note.txt'), 'hello workspace');

  const entries = await workspace.listFiles('files');
  assert.deepEqual(entries, [
    {
      name: 'note.txt',
      path: 'files/note.txt',
      type: 'file',
    },
  ]);

  await workspace.deleteFile('files/note.txt');

  await assert.rejects(
    () => workspace.readFile('files/note.txt'),
    NotFoundError,
  );
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
  const linkPath = path.join(root, 'files', 'outside-link');

  await fs.symlink(outsideDir, linkPath);

  await assert.rejects(
    () => workspace.writeFile('files/outside-link/secret.txt', 'blocked'),
    ValidationError,
  );
});
