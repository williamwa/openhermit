import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';

import { withApproval } from '../src/tools.js';
import { createSecurityFixture } from './helpers.js';

test('withApproval forwards signal and onUpdate to the wrapped tool', async (t) => {
  const { security } = await createSecurityFixture(t, {
    security: {
      autonomy_level: 'supervised',
      require_approval_for: ['dangerous_tool'],
    },
  });
  await security.load();

  const Params = Type.Object({
    value: Type.String(),
  });

  let capturedSignal: AbortSignal | undefined;
  let capturedOnUpdate: AgentToolUpdateCallback<{ status: string }> | undefined;
  let approvalArgs: unknown;

  const tool: AgentTool<typeof Params, { status: string }> = {
    name: 'dangerous_tool',
    label: 'Dangerous Tool',
    description: 'Tool used to verify approval forwarding.',
    parameters: Params,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      capturedSignal = signal;
      capturedOnUpdate = onUpdate;
      onUpdate?.({
        content: [{ type: 'text', text: `updating ${args.value}` }],
        details: { status: 'midway' },
      });

      return {
        content: [{ type: 'text', text: `done ${args.value}` }],
        details: { status: 'done' },
      };
    },
  };

  const wrapped = withApproval(tool, security, async (_toolName, _toolCallId, args) => {
    approvalArgs = args;
    return true;
  });

  const abortController = new AbortController();
  const updates: Array<{ status: string }> = [];

  const result = await wrapped.execute(
    'call-1',
    { value: 'payload' },
    abortController.signal,
    ((partial) => {
      updates.push(partial.details);
    }) as AgentToolUpdateCallback<{ status: string }>,
  );

  assert.equal(capturedSignal, abortController.signal);
  assert.ok(capturedOnUpdate);
  assert.deepEqual(approvalArgs, { value: 'payload' });
  assert.deepEqual(updates, [{ status: 'midway' }]);
  assert.deepEqual(result.details, { status: 'done' });
});
