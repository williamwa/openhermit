import { randomUUID } from 'node:crypto';

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
  formatJson,
} from './shared.js';

const MemoryRecallParams = Type.Object({
  query: Type.String({
    description: 'Keyword or phrase to search in named system memory.',
  }),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of matches to return. Defaults to 5.',
    }),
  ),
  key_prefix: Type.Optional(
    Type.String({
      description:
        'Optional memory-key prefix filter, for example "project/openhermit/" or "user/preferences/".',
    }),
  ),
});

type MemoryRecallArgs = Static<typeof MemoryRecallParams>;

const MemoryGetParams = Type.Object({
  key: Type.String({
    description:
      'Exact memory key to read, for example "main", "now", or "project/openhermit/plan".',
  }),
});

type MemoryGetArgs = Static<typeof MemoryGetParams>;

const MemoryUpdateParams = Type.Object({
  key: Type.Optional(
    Type.String({
      description:
        'Stable memory key. Prefer semantic keys such as "main", "now", "project/openhermit/plan", or "user/preferences/style". If omitted, one is generated automatically.',
    }),
  ),
  title: Type.Optional(
    Type.String({
      description: 'Short title for this long-term memory entry.',
    }),
  ),
  content: Type.String({
    description: 'The memory content to store.',
  }),
  tags: Type.Optional(
    Type.Array(
      Type.String({
        description: 'Optional tags to help future retrieval.',
      }),
    ),
  ),
});

type MemoryUpdateArgs = Static<typeof MemoryUpdateParams>;

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

const normalizeLongTermMemoryKey = (args: MemoryUpdateArgs): string => {
  if (args.key && args.key.trim()) {
    return args.key.trim();
  }

  const seed = args.title?.trim() || args.content.trim().slice(0, 48);
  const slug = slugify(seed);

  return slug.length > 0
    ? `notes/${slug}`
    : `notes/${randomUUID().slice(0, 8)}`;
};

export const createMemoryGetTool = ({
  memoryStore,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryGetParams> => ({
  name: 'memory_get',
  label: 'Get Memory',
  description:
    'Read one named system memory entry by exact key. Use this after memory_recall when you need the full current content before updating it.',
  parameters: MemoryGetParams,
  execute: async (_toolCallId, args: MemoryGetArgs) => {
    if (!memoryStore || !storeScope) {
      throw new ValidationError('memory_get is unavailable: no memory store is configured.');
    }

    const key = args.key.trim();

    if (!key) {
      throw new ValidationError('memory_get requires a non-empty key.');
    }

    const entry = await memoryStore.getMemoryEntry(storeScope, key);

    if (!entry) {
      throw new ValidationError(`Memory not found: ${key}`);
    }

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

export const createMemoryRecallTool = ({
  memoryStore,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryRecallParams> => ({
  name: 'memory_recall',
  label: 'Recall Memory',
  description:
    'Search named system memory records such as "main", "now", and structured keys like "project/openhermit/plan". Use this to recall saved preferences, stable facts, current focus, or durable project knowledge.',
  parameters: MemoryRecallParams,
  execute: async (_toolCallId, args: MemoryRecallArgs) => {
    if (!memoryStore || !storeScope) {
      throw new ValidationError('memory_recall is unavailable: no memory store is configured.');
    }

    const query = args.query.trim();

    if (!query) {
      throw new ValidationError('memory_recall requires a non-empty query.');
    }

    const limit = Math.max(1, Math.min(10, Math.trunc(args.limit ?? 5)));
    const matches = await memoryStore.recallLongTermMemories(
      storeScope,
      query,
      limit,
      args.key_prefix,
    );

    const text = matches.length > 0
      ? formatJson(matches)
      : 'No long-term memory entries matched.\n';

    return {
      content: asTextContent(text),
      details: {
        query,
        limit,
        ...(args.key_prefix ? { keyPrefix: args.key_prefix } : {}),
        count: matches.length,
        matches,
      },
    };
  },
});

export const createMemoryUpdateTool = ({
  security,
  memoryStore,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryUpdateParams> => ({
  name: 'memory_update',
  label: 'Update Memory',
  description:
    'Create or update a named system memory entry. Use "main" for stable durable memory, "now" for current cross-session focus, and structured keys like "project/openhermit/plan" for topic-specific memory.',
  parameters: MemoryUpdateParams,
  execute: async (_toolCallId, args: MemoryUpdateArgs) => {
    ensureAutonomyAllows(security, 'memory_update');

    if (!memoryStore || !storeScope) {
      throw new ValidationError('memory_update is unavailable: no memory store is configured.');
    }

    const content = args.content.trim();

    if (!content) {
      throw new ValidationError('memory_update requires non-empty content.');
    }

    const key = normalizeLongTermMemoryKey(args);
    const updated = await memoryStore.upsertLongTermMemory(storeScope, {
      key,
      content,
      ...(args.title?.trim() ? { title: args.title.trim() } : {}),
      ...(args.tags?.length ? { tags: args.tags.map((tag) => tag.trim()).filter(Boolean) } : {}),
      updatedAt: new Date().toISOString(),
      kind: key === 'main' ? 'main' : key === 'now' ? 'now' : 'named',
    });

    return {
      content: asTextContent(formatJson(updated)),
      details: updated,
    };
  },
});
