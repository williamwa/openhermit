import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSystemPrompt } from '../src/agent-runner/prompt.js';
import { createSecurityFixture } from './helpers.js';

const allCapabilities = {
  hasMemoryTools: true,
  hasInstructionTools: true,
  hasExecTool: true,
  hasContainerTools: true,
  hasWebTools: true,
};

test('buildSystemPrompt includes container mounting guidance when container tools are available', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, allCapabilities);

  assert.match(prompt, /Mounting files into service containers/);
  assert.match(prompt, /mount_target/);
  assert.match(prompt, /Autonomy level: supervised/);
});

test('buildSystemPrompt omits container section when container tools are not available', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, {
    ...allCapabilities,
    hasContainerTools: false,
  });

  assert.doesNotMatch(prompt, /container_start/);
  assert.doesNotMatch(prompt, /mount_target/);
  assert.match(prompt, /Autonomy level: supervised/);
});

test('buildSystemPrompt omits memory section when memory tools are not available', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, {
    ...allCapabilities,
    hasMemoryTools: false,
  });

  assert.doesNotMatch(prompt, /memory_add/);
  assert.doesNotMatch(prompt, /memory_recall/);
});

test('buildSystemPrompt includes all sections when all capabilities are present', async (t) => {
  const { security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const prompt = await buildSystemPrompt(config, security, allCapabilities);

  assert.match(prompt, /## Memory/);
  assert.match(prompt, /## Execution/);
  assert.match(prompt, /## Containers/);
  assert.match(prompt, /## Web/);
  assert.match(prompt, /## Instructions Management/);
});
