import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Provider, StopReason, Usage } from '@mariozechner/pi-ai';

import {
  estimateTextTokens,
  estimateAgentMessageTokens,
  estimateAgentMessagesTokens,
  getCompactionRetainedStartIndex,
  summarizeMessageForCompaction,
  buildContextCompactionBlock,
  compactContextIfNeeded,
  type CompactionDeps,
  type CompactionOptions,
} from '../src/agent-runner/context-compaction.js';
import type { AgentConfig } from '../src/core/types.js';

// ── Helpers ────────────────────────────────────────────────────────────

const makeUserMessage = (text: string, ts = Date.now()): AgentMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp: ts,
});

const stubUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

const assistantDefaults = {
  api: 'anthropic-messages' as Api,
  provider: 'anthropic' as Provider,
  model: 'claude-sonnet-4-20250514',
  usage: stubUsage,
  stopReason: 'stop' as StopReason,
};

const makeAssistantMessage = (text: string, ts = Date.now()): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  ...assistantDefaults,
  timestamp: ts,
});

const makeToolCallMessage = (toolName: string, ts = Date.now()): AgentMessage => ({
  role: 'assistant',
  content: [
    { type: 'toolCall', id: `call-${toolName}`, name: toolName, arguments: {} },
  ],
  ...assistantDefaults,
  timestamp: ts,
});

const makeToolResultMessage = (toolName: string, text: string, ts = Date.now()): AgentMessage => ({
  role: 'toolResult',
  toolCallId: `call-${toolName}`,
  toolName,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: ts,
});

const stubConfig: AgentConfig = {
  workspace_root: '/workspace',
  model: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', max_tokens: 4096 },
  http_api: { preferred_port: 3000 },
  memory: {},
};

const createStubDeps = (overrides?: Partial<CompactionDeps>): CompactionDeps => ({
  store: {
    messages: {
      getCompactionSummary: async () => undefined,
      setCompactionSummary: async () => {},
    },
  } as unknown as CompactionDeps['store'],
  scope: { agentId: 'test-agent' },
  options: {
    contextCompactionMaxTokens: 200,
    contextCompactionRecentMessageCount: 2,
    contextCompactionSummaryMaxChars: 800,
  },
  logRuntime: () => {},
  ...overrides,
});

// ── Token estimation ───────────────────────────────────────────────────

test('estimateTextTokens returns at least 1 for empty string', () => {
  assert.equal(estimateTextTokens(''), 1);
});

test('estimateTextTokens approximates 4 chars per token', () => {
  assert.equal(estimateTextTokens('abcdefgh'), 2);
  assert.equal(estimateTextTokens('a'.repeat(100)), 25);
});

test('estimateAgentMessageTokens includes role overhead', () => {
  const user = makeUserMessage('hello');
  const tokens = estimateAgentMessageTokens(user);
  assert.ok(tokens > estimateTextTokens('hello'));
});

test('estimateAgentMessagesTokens sums all messages', () => {
  const messages = [makeUserMessage('a'), makeAssistantMessage('b')];
  const total = estimateAgentMessagesTokens(messages);
  assert.equal(
    total,
    estimateAgentMessageTokens(messages[0]!) + estimateAgentMessageTokens(messages[1]!),
  );
});

// ── getCompactionRetainedStartIndex ────────────────────────────────────

test('getCompactionRetainedStartIndex retains the last N messages', () => {
  const messages = [
    makeUserMessage('a'),
    makeAssistantMessage('b'),
    makeUserMessage('c'),
    makeAssistantMessage('d'),
  ];
  assert.equal(getCompactionRetainedStartIndex(messages, 2), 2);
});

test('getCompactionRetainedStartIndex pulls back to include assistant before toolResult', () => {
  const messages = [
    makeUserMessage('a'),
    makeToolCallMessage('exec'),
    makeToolResultMessage('exec', 'done'),
    makeUserMessage('c'),
  ];
  // retainCount=2 → startIndex=2, but messages[2] is toolResult and messages[1] is assistant
  assert.equal(getCompactionRetainedStartIndex(messages, 2), 1);
});

// ── summarizeMessageForCompaction ──────────────────────────────────────

test('summarizeMessageForCompaction formats user message', () => {
  const result = summarizeMessageForCompaction(makeUserMessage('hello world'));
  assert.equal(result, 'User: hello world');
});

test('summarizeMessageForCompaction formats assistant text', () => {
  const result = summarizeMessageForCompaction(makeAssistantMessage('reply here'));
  assert.equal(result, 'Agent: reply here');
});

test('summarizeMessageForCompaction formats tool-only assistant', () => {
  const result = summarizeMessageForCompaction(makeToolCallMessage('exec'));
  assert.equal(result, 'Agent used tools: exec');
});

test('summarizeMessageForCompaction formats tool result', () => {
  const result = summarizeMessageForCompaction(makeToolResultMessage('exec', 'output'));
  assert.equal(result, 'Tool exec: output');
});

test('summarizeMessageForCompaction returns undefined for unknown role', () => {
  const result = summarizeMessageForCompaction({ role: 'unknown' } as unknown as AgentMessage);
  assert.equal(result, undefined);
});

// ── buildContextCompactionBlock ────────────────────────────────────────

test('buildContextCompactionBlock returns undefined for empty compacted messages', () => {
  const result = buildContextCompactionBlock({
    compactedMessages: [],

    retainedMessageCount: 5,
    originalMessageCount: 5,
    llmSummary: undefined,
    options: {},
  });
  assert.equal(result, undefined);
});

test('buildContextCompactionBlock includes LLM summary when present', () => {
  const result = buildContextCompactionBlock({
    compactedMessages: [makeUserMessage('old message')],

    retainedMessageCount: 3,
    originalMessageCount: 4,
    llmSummary: 'The user discussed project architecture.',
    options: {},
  });
  assert.ok(result);
  const text = JSON.stringify(result.content);
  assert.ok(text.includes('The user discussed project architecture'));
  assert.ok(text.includes('Earlier messages compacted: 1 of 4'));
  // Should NOT include text-extraction fallback when LLM summary is present.
  assert.ok(!text.includes('Compacted earlier session history'));
});

test('buildContextCompactionBlock falls back to text extraction without LLM summary', () => {
  const result = buildContextCompactionBlock({
    compactedMessages: [makeUserMessage('hello'), makeAssistantMessage('world')],

    retainedMessageCount: 2,
    originalMessageCount: 4,
    llmSummary: undefined,
    options: {},
  });
  assert.ok(result);
  const text = JSON.stringify(result.content);
  assert.ok(text.includes('Compacted earlier session history'));
  assert.ok(text.includes('User: hello'));
});

// ── compactContextIfNeeded ─────────────────────────────────────────────

test('compactContextIfNeeded returns combined when under budget', async () => {
  const context = [makeUserMessage('ctx')];
  const messages = [makeUserMessage('a'), makeAssistantMessage('b')];
  const deps = createStubDeps({
    options: { contextCompactionMaxTokens: 100_000 },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, context, messages, deps);
  assert.equal(result.length, 3);
});

test('compactContextIfNeeded returns combined when only 1 message', async () => {
  const context: AgentMessage[] = [];
  const messages = [makeUserMessage('a'.repeat(10_000))];
  const deps = createStubDeps({
    options: { contextCompactionMaxTokens: 10 },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, context, messages, deps);
  assert.equal(result.length, 1);
});

test('compactContextIfNeeded compacts when over budget', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('final question'),
    makeAssistantMessage('final answer'),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 800,
      contextCompactionRecentMessageCount: 2,
    },
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  // Should have fewer messages than original.
  assert.ok(result.length < messages.length);
  // Should include the compaction summary block.
  assert.ok(
    result.some(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('Context compaction summary'),
    ),
  );
  // Should preserve recent messages.
  assert.ok(
    result.some(
      (m) => m.role === 'assistant' && JSON.stringify(m.content).includes('final answer'),
    ),
  );
});

test('compactContextIfNeeded uses persisted summary when no agent factory', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('recent'),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 200,
      contextCompactionRecentMessageCount: 1,
    },
    store: {
      messages: {
        getCompactionSummary: async () => 'Previously generated LLM summary about architecture.',
        setCompactionSummary: async () => {},
      },
    } as unknown as CompactionDeps['store'],
    createCompactionAgent: undefined,
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  const compactionBlock = result.find(
    (m) => m.role === 'user' && JSON.stringify(m.content).includes('Previously generated LLM summary'),
  );
  assert.ok(compactionBlock, 'should use persisted LLM summary');
});

test('compactContextIfNeeded falls back to text extraction when compaction summary read fails', async () => {
  const longText = 'word '.repeat(200).trim();
  const messages = [
    makeUserMessage(longText),
    makeAssistantMessage(longText),
    makeUserMessage('recent'),
  ];
  const deps = createStubDeps({
    options: {
      contextCompactionMaxTokens: 400,
      contextCompactionRecentMessageCount: 1,
      contextCompactionSummaryMaxChars: 100,
    },
    store: {
      messages: {
        getCompactionSummary: async () => { throw new Error('db error'); },
        setCompactionSummary: async () => {},
      },
    } as unknown as CompactionDeps['store'],
    createCompactionAgent: undefined,
  });

  const result = await compactContextIfNeeded('s1', stubConfig, [], messages, deps);
  // Should still produce a compaction block with text extraction.
  assert.ok(
    result.some(
      (m) => m.role === 'user' && JSON.stringify(m.content).includes('Compacted earlier session history'),
    ),
  );
});
