import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createBuiltInTools } from '../src/tools.js';
import { buildSystemPrompt } from '../src/agent-runner/prompt.js';
import { createSecurityFixture } from './helpers.js';

test('buildSystemPrompt includes container guidance only when container tools are available', async (t) => {
  const { workspace, security } = await createSecurityFixture(t);
  await security.load();
  const config = await security.readConfig();

  const defaultTools = createBuiltInTools({
    workspace,
    security,
    containerManager: {
      runEphemeral: async () => {
        throw new Error('not used');
      },
      startService: async () => {
        throw new Error('not used');
      },
      stopService: async () => {
        throw new Error('not used');
      },
      execInService: async () => {
        throw new Error('not used');
      },
      listAll: async () => [],
    } as any,
  });

  const withContainerGuidance = await buildSystemPrompt(
    config,
    workspace,
    security,
    defaultTools,
  );
  const withoutContainerGuidance = await buildSystemPrompt(
    config,
    workspace,
    security,
    [],
  );

  assert.match(withContainerGuidance, /## Container Tool Rules/);
  assert.match(withContainerGuidance, /Container tool rules:/);
  assert.doesNotMatch(withoutContainerGuidance, /## Container Tool Rules/);
  assert.doesNotMatch(withoutContainerGuidance, /Container tool rules:/);
});
