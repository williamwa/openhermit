import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AgentEventBus } from '../src/events.js';

test('listener events run in priority order', async () => {
  const bus = new AgentEventBus();
  const calls: string[] = [];
  bus.on('agent.started@v1', () => { calls.push('B'); }, { priority: 200 });
  bus.on('agent.started@v1', () => { calls.push('A'); }, { priority: 50 });
  await bus.emit('agent.started@v1', { agentId: 'x', at: '2026-01-01' });
  assert.deepEqual(calls, ['A', 'B']);
});

test('transform events thread the payload through handlers', async () => {
  const bus = new AgentEventBus();
  bus.on('prompt.assemble@v1', (p) => ({
    ...p,
    sections: [...p.sections, { key: 'a', content: 'one' }],
  }));
  bus.on('prompt.assemble@v1', (p) => ({
    ...p,
    sections: [...p.sections, { key: 'b', content: 'two' }],
  }), { priority: 200 });
  const out = await bus.transform('prompt.assemble@v1', {
    agentId: 'x', sessionId: 's', sections: [],
  });
  assert.deepEqual(out.sections.map((s) => s.key), ['a', 'b']);
});

test('veto event short-circuits on the first denial', async () => {
  const bus = new AgentEventBus();
  let allowedRan = false;
  bus.on('tool.before@v1', () => { allowedRan = true; return { allow: true }; }, { priority: 500 });
  bus.on('tool.before@v1', () => ({ allow: false, reason: 'blocked by policy' }), { priority: 100 });
  const decision = await bus.veto('tool.before@v1', {
    agentId: 'x', sessionId: 's', toolName: 'exec', toolCallId: 'tc1', args: {},
  });
  assert.equal(decision.allow, false);
  if (decision.allow === false) assert.equal(decision.reason, 'blocked by policy');
  assert.equal(allowedRan, false, 'lower-priority handler should not have run after veto');
});

test('throwing handler in skip mode is dropped, others continue', async () => {
  const bus = new AgentEventBus();
  const calls: string[] = [];
  bus.on('agent.started@v1', () => { throw new Error('boom'); }, { pluginId: 'bad' });
  bus.on('agent.started@v1', () => { calls.push('still ran'); });
  await bus.emit('agent.started@v1', { agentId: 'x', at: 'now' });
  assert.deepEqual(calls, ['still ran']);
});

test('throwing handler in fail mode propagates', async () => {
  const bus = new AgentEventBus();
  bus.on('agent.started@v1', () => { throw new Error('explicit fail'); }, { failureMode: 'fail' });
  await assert.rejects(
    () => bus.emit('agent.started@v1', { agentId: 'x', at: 'now' }),
    /explicit fail/,
  );
});

test('removePlugin() drops every subscription for that plugin', async () => {
  const bus = new AgentEventBus();
  const calls: string[] = [];
  bus.on('agent.started@v1', () => { calls.push('plugin-a'); }, { pluginId: 'a' });
  bus.on('agent.started@v1', () => { calls.push('plugin-b'); }, { pluginId: 'b' });
  bus.removePlugin('a');
  await bus.emit('agent.started@v1', { agentId: 'x', at: 'now' });
  assert.deepEqual(calls, ['plugin-b']);
});

test('emit() rejects non-listener events', async () => {
  const bus = new AgentEventBus();
  await assert.rejects(
    () => bus.emit('prompt.assemble@v1' as never, {} as never),
    /transform/,
  );
});
