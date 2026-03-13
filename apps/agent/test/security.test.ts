import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';

import { NotFoundError, ValidationError } from '@openhermit/shared';

import { createSecurityFixture } from './helpers.js';

test('AgentSecurity loads the default policy and approval list', async (t) => {
  const { security } = await createSecurityFixture(t);

  await security.load();

  assert.equal(security.getAutonomyLevel(), 'supervised');
  assert.equal(security.requiresApproval('delete_file'), true);
  assert.equal(security.requiresApproval('read_file'), false);
  assert.deepEqual(security.listSecretNames(), []);
});

test('AgentSecurity resolves configured secrets', async (t) => {
  const { security } = await createSecurityFixture(t);

  await fs.writeFile(
    security.secretsFilePath,
    `${JSON.stringify(
      {
        ANTHROPIC_API_KEY: 'secret-key',
        TELEGRAM_BOT_TOKEN: 'bot-token',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

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
  const { security } = await createSecurityFixture(t);

  await fs.writeFile(
    security.securityFilePath,
    `${JSON.stringify(
      {
        autonomy_level: 'dangerous',
        require_approval_for: [],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await assert.rejects(() => security.load(), ValidationError);
});

test('AgentSecurity surfaces security.json parse errors with the file path', async (t) => {
  const { security } = await createSecurityFixture(t);

  await fs.writeFile(
    security.securityFilePath,
    '{\n  "autonomy_level": "supervised",\n  "require_approval_for": [\n}\n',
    'utf8',
  );

  await assert.rejects(
    () => security.load(),
    /Invalid JSON in .*security\.json:/i,
  );
});
