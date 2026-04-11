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
    description: 'Keyword or phrase to search in memory.',
  }),
  limit: Type.Optional(
    Type.Number({
      description: 'Maximum number of matches to return. Defaults to 5.',
    }),
  ),
});

type MemoryRecallArgs = Static<typeof MemoryRecallParams>;

const MemoryGetParams = Type.Object({
  id: Type.String({
    description:
      'Exact memory entry ID to read.',
  }),
});

type MemoryGetArgs = Static<typeof MemoryGetParams>;

const MemoryUpdateParams = Type.Object({
  id: Type.String({
    description: 'ID of the memory entry to update.',
  }),
  content: Type.Optional(
    Type.String({
      description: 'New content for the memory entry.',
    }),
  ),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Metadata to merge into the existing entry.',
    }),
  ),
});

type MemoryUpdateArgs = Static<typeof MemoryUpdateParams>;

const MemoryAddParams = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        'Stable memory ID. Prefer semantic keys such as "project/openhermit/plan" or "user/preferences/style". If omitted, one is generated automatically.',
    }),
  ),
  content: Type.String({
    description: 'The memory content to store.',
  }),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Optional metadata (e.g. title, tags) to help future retrieval.',
    }),
  ),
});

type MemoryAddArgs = Static<typeof MemoryAddParams>;

const MemoryDeleteParams = Type.Object({
  id: Type.String({
    description: 'ID of the memory entry to delete.',
  }),
});

type MemoryDeleteArgs = Static<typeof MemoryDeleteParams>;

export const createMemoryGetTool = ({
  memoryProvider,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryGetParams> => ({
  name: 'memory_get',
  label: 'Get Memory',
  description:
    'Read one memory entry by exact ID.',
  parameters: MemoryGetParams,
  execute: async (_toolCallId, args: MemoryGetArgs) => {
    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_get is unavailable: no memory provider is configured.');
    }

    const id = args.id.trim();
    if (!id) {
      throw new ValidationError('memory_get requires a non-empty id.');
    }

    const entry = await memoryProvider.get(storeScope, id);
    if (!entry) {
      throw new ValidationError(`Memory not found: ${id}`);
    }

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

export const createMemoryRecallTool = ({
  memoryProvider,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryRecallParams> => ({
  name: 'memory_recall',
  label: 'Recall Memory',
  description:
    'Search memory entries by keyword or phrase. Use this to recall saved preferences, facts, or project knowledge.',
  parameters: MemoryRecallParams,
  execute: async (_toolCallId, args: MemoryRecallArgs) => {
    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_recall is unavailable: no memory provider is configured.');
    }

    const query = args.query.trim();
    if (!query) {
      throw new ValidationError('memory_recall requires a non-empty query.');
    }

    const limit = Math.max(1, Math.min(10, Math.trunc(args.limit ?? 5)));
    const matches = await memoryProvider.search(storeScope, query, { limit });

    const text = matches.length > 0
      ? formatJson(matches)
      : 'No memory entries matched.\n';

    return {
      content: asTextContent(text),
      details: {
        query,
        limit,
        count: matches.length,
        matches,
      },
    };
  },
});

export const createMemoryAddTool = ({
  security,
  memoryProvider,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryAddParams> => ({
  name: 'memory_add',
  label: 'Add Memory',
  description:
    'Create or upsert a memory entry. Use semantic IDs like "project/plan" or "user/preferences" for stable entries, or omit the ID for auto-generated ones.',
  parameters: MemoryAddParams,
  execute: async (_toolCallId, args: MemoryAddArgs) => {
    ensureAutonomyAllows(security, 'memory_add');

    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_add is unavailable: no memory provider is configured.');
    }

    const content = args.content.trim();
    if (!content) {
      throw new ValidationError('memory_add requires non-empty content.');
    }

    const entry = await memoryProvider.add(storeScope, {
      ...(args.id?.trim() ? { id: args.id.trim() } : {}),
      content,
      ...(args.metadata ? { metadata: args.metadata as Record<string, unknown> } : {}),
    });

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

export const createMemoryUpdateTool = ({
  security,
  memoryProvider,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryUpdateParams> => ({
  name: 'memory_update',
  label: 'Update Memory',
  description:
    'Update an existing memory entry by ID. Use memory_get first to read the current content before updating.',
  parameters: MemoryUpdateParams,
  execute: async (_toolCallId, args: MemoryUpdateArgs) => {
    ensureAutonomyAllows(security, 'memory_update');

    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_update is unavailable: no memory provider is configured.');
    }

    const id = args.id.trim();
    if (!id) {
      throw new ValidationError('memory_update requires a non-empty id.');
    }

    const entry = await memoryProvider.update(storeScope, id, {
      ...(args.content?.trim() ? { content: args.content.trim() } : {}),
      ...(args.metadata ? { metadata: args.metadata as Record<string, unknown> } : {}),
    });

    return {
      content: asTextContent(formatJson(entry)),
      details: entry,
    };
  },
});

export const createMemoryDeleteTool = ({
  security,
  memoryProvider,
  storeScope,
}: ToolContext): AgentTool<typeof MemoryDeleteParams> => ({
  name: 'memory_delete',
  label: 'Delete Memory',
  description:
    'Delete a memory entry by ID.',
  parameters: MemoryDeleteParams,
  execute: async (_toolCallId, args: MemoryDeleteArgs) => {
    ensureAutonomyAllows(security, 'memory_delete');

    if (!memoryProvider || !storeScope) {
      throw new ValidationError('memory_delete is unavailable: no memory provider is configured.');
    }

    const id = args.id.trim();
    if (!id) {
      throw new ValidationError('memory_delete requires a non-empty id.');
    }

    await memoryProvider.delete(storeScope, id);

    return {
      content: asTextContent(`Deleted memory: ${id}\n`),
      details: { id },
    };
  },
});
