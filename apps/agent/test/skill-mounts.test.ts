import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { syncSkillMounts } from '../../gateway/src/skill-mounts.js';
import { createTempDir } from './helpers.js';

const createFakeSkillStore = (skills: Array<{ id: string; path: string }>) => ({
  listEnabled: async () => skills.map((s) => ({ ...s, name: s.id, description: '' })),
});

const systemDir = (workspaceDir: string): string =>
  path.join(workspaceDir, '.openhermit', 'skills', 'system');

test('syncSkillMounts copies skill directories into workspace system dir', async (t) => {
  const workspaceDir = await createTempDir(t, 'workspace-');
  const sourceDir = await createTempDir(t, 'source-');

  const skillSrc = path.join(sourceDir, 'skill-a');
  await fs.mkdir(skillSrc);
  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'content');

  const store = createFakeSkillStore([{ id: 'skill-a', path: skillSrc }]);
  await syncSkillMounts('agent-1', workspaceDir, store as any);

  const copied = await fs.readFile(
    path.join(systemDir(workspaceDir), 'skill-a', 'SKILL.md'),
    'utf8',
  );
  assert.equal(copied, 'content');
});

test('syncSkillMounts removes stale entries', async (t) => {
  const workspaceDir = await createTempDir(t, 'workspace-');

  const dir = systemDir(workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  const staleDir = path.join(dir, 'old-skill');
  await fs.mkdir(staleDir);
  await fs.writeFile(path.join(staleDir, 'SKILL.md'), 'stale');

  const store = createFakeSkillStore([]);
  await syncSkillMounts('agent-1', workspaceDir, store as any);

  const entries = await fs.readdir(dir);
  assert.equal(entries.length, 0);
});

test('syncSkillMounts creates system dir if missing', async (t) => {
  const workspaceDir = await createTempDir(t, 'workspace-');

  const store = createFakeSkillStore([]);
  await syncSkillMounts('agent-1', workspaceDir, store as any);

  const stat = await fs.stat(systemDir(workspaceDir));
  assert.ok(stat.isDirectory());
});

test('syncSkillMounts replaces existing copy with updated content', async (t) => {
  const workspaceDir = await createTempDir(t, 'workspace-');
  const sourceDir = await createTempDir(t, 'source-');

  const skillSrc = path.join(sourceDir, 'skill-b');
  await fs.mkdir(skillSrc);
  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'v1');

  const store = createFakeSkillStore([{ id: 'skill-b', path: skillSrc }]);
  await syncSkillMounts('agent-1', workspaceDir, store as any);

  await fs.writeFile(path.join(skillSrc, 'SKILL.md'), 'v2');
  await syncSkillMounts('agent-1', workspaceDir, store as any);

  const content = await fs.readFile(
    path.join(systemDir(workspaceDir), 'skill-b', 'SKILL.md'),
    'utf8',
  );
  assert.equal(content, 'v2');
});
