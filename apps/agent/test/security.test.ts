import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NotFoundError, ValidationError } from '@openhermit/shared';

import { createSecurityFixture } from './helpers.js';

test('AgentSecurity loads the default policy and approval list', async (t) => {
  const { security } = await createSecurityFixture(t, {
    security: { autonomy_level: 'supervised', require_approval_for: ['container_start'] },
  });

  await security.load();

  assert.equal(security.getAutonomyLevel(), 'supervised');
  assert.equal(security.requiresApproval('container_start'), true);
  assert.equal(security.requiresApproval('exec'), false);
  assert.deepEqual(security.listSecretNames(), []);
});

test('AgentSecurity resolves configured secrets', async (t) => {
  const { security } = await createSecurityFixture(t, {
    secrets: {
      ANTHROPIC_API_KEY: 'secret-key',
      TELEGRAM_BOT_TOKEN: 'bot-token',
    },
  });

  await security.load();

  assert.deepEqual(security.listSecretNames(), [
    'ANTHROPIC_API_KEY',
    'TELEGRAM_BOT_TOKEN',
  ]);
  assert.deepEqual(security.resolveSecrets(['ANTHROPIC_API_KEY']), {
    ANTHROPIC_API_KEY: 'secret-key',
  });
  assert.throws(
    () => security.resolveSecrets(['MISSING_SECRET']),
    NotFoundError,
  );
});

test('AgentSecurity rejects invalid autonomy levels', async (t) => {
  const { security, configStore, agentId } = await createSecurityFixture(t);

  await configStore.setSecurity(agentId, {
    autonomy_level: 'dangerous',
    require_approval_for: [],
  });

  await assert.rejects(() => security.load(), ValidationError);
});

test('AgentSecurity scaffolds and reads the default runtime config', async (t) => {
  const { security, root } = await createSecurityFixture(t);

  const config = await security.readConfig();

  assert.equal(config.workspace_root, root);
  assert.equal(config.model.provider, 'anthropic');
  assert.ok(config.exec, 'exec config should be populated by default');
  assert.equal(config.web?.provider, 'defuddle');
  assert.equal(config.memory.introspection?.enabled, true);
});

test('AgentSecurity readConfig fails clearly when DB has no config', async (t) => {
  const { security } = await createSecurityFixture(t, { skipConfig: true });
  await assert.rejects(
    () => security.readConfig(),
    /Agent config missing/i,
  );
});

test('AgentSecurity writeConfig persists into the config store', async (t) => {
  const { security, configStore, agentId } = await createSecurityFixture(t);
  const config = await security.readRawConfig();
  await security.writeConfig({ ...config, model: { ...config.model, max_tokens: 4096 } });
  const stored = await configStore.getConfig(agentId);
  assert.equal((stored as any).model.max_tokens, 4096);
});

test('AgentSecurity readSecurityPolicy / writeSecurityPolicy round-trip', async (t) => {
  const { security } = await createSecurityFixture(t);
  const policy = await security.readSecurityPolicy();
  assert.equal(typeof policy.autonomy_level, 'string');

  await security.writeSecurityPolicy({
    autonomy_level: 'readonly',
    require_approval_for: ['exec'],
  });
  const updated = await security.readSecurityPolicy();
  assert.equal(updated.autonomy_level, 'readonly');
  assert.deepEqual(updated.require_approval_for, ['exec']);
});
