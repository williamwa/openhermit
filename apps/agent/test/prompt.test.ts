import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSystemPrompt } from '../src/agent-runner/prompt.js';
import { createSecurityFixture } from './helpers.js';

test('buildSystemPrompt includes container mounting guidance and autonomy level', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security);

  assert.match(prompt, /Mounting files into service containers/);
  assert.match(prompt, /mount_target/);
  assert.match(prompt, /Autonomy level: supervised/);
});
