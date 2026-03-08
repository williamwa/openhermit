import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentTool, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import { Type } from '@mariozechner/pi-ai';

import { withApproval } from '../src/tools.js';
import { createSecurityFixture } from './helpers.js';

const getFirstText = (result: {
  content: Array<{ type: string; text?: string }>;
}): string => {
  const first = result.content.find((entry) => entry.type === 'text');
  return typeof first?.text === 'string' ? first.text : '';
};

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
    return 'approved';
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

test('withApproval distinguishes timeout from explicit rejection', async (t) => {
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

  const tool: AgentTool<typeof Params, { status: string }> = {
    name: 'dangerous_tool',
    label: 'Dangerous Tool',
    description: 'Tool used to verify approval decisions.',
    parameters: Params,
    execute: async () => {
      throw new Error('should not execute when approval is not granted');
    },
  };

  const timedOut = withApproval(tool, security, async () => 'timed_out');
  const rejected = withApproval(tool, security, async () => 'rejected');

  const timedOutResult = await timedOut.execute('call-timeout', { value: 'payload' });
  const rejectedResult = await rejected.execute('call-rejected', { value: 'payload' });

  assert.match(getFirstText(timedOutResult), /timed out waiting for user approval/);
  assert.deepEqual(timedOutResult.details, {
    rejected: true,
    toolName: 'dangerous_tool',
    approvalStatus: 'timed_out',
  });

  assert.match(getFirstText(rejectedResult), /rejected by the user/);
  assert.deepEqual(rejectedResult.details, {
    rejected: true,
    toolName: 'dangerous_tool',
    approvalStatus: 'rejected',
  });
});
