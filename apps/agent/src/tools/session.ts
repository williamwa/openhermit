import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import { ValidationError } from '@openhermit/shared';

import {
  type ToolContext,
  asTextContent,
  formatJson,
} from './shared.js';

// ── Parameters ──────────────────────────────────────────────────────

const SessionListParams = Type.Object({
  channel: Type.Optional(Type.String({ description: 'Filter by channel/platform (e.g. "telegram", "cli", "web").' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of sessions to return (default 20).' })),
});

type SessionListArgs = Static<typeof SessionListParams>;

const SessionReadParams = Type.Object({
  session_id: Type.String({ description: 'Session ID to read messages from.' }),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of recent messages to return (default 50).' })),
});

type SessionReadArgs = Static<typeof SessionReadParams>;

const SessionSummaryParams = Type.Object({
  session_id: Type.String({ description: 'Session ID to summarize.' }),
});

type SessionSummaryArgs = Static<typeof SessionSummaryParams>;

// ── Tools ───────────────────────────────────────────────────────────

export const createSessionListTool = (context: ToolContext): AgentTool<typeof SessionListParams> => ({
  name: 'session_list',
  label: 'List Sessions',
  description: 'List sessions with their descriptions, last activity, message counts, and source. Optionally filter by channel.',
  parameters: SessionListParams,
  execute: async (_toolCallId, args: SessionListArgs) => {
    if (!context.sessionStore || !context.storeScope) {
      throw new ValidationError('session_list is unavailable: no session store is configured.');
    }

    let sessions = await context.sessionStore.list(context.storeScope);

    // Filter by channel/platform if specified
    if (args.channel) {
      const ch = args.channel.trim().toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.source.platform?.toLowerCase() === ch ||
          s.source.kind?.toLowerCase() === ch,
      );
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

    // Apply limit
    const limit = args.limit ?? 20;
    const limited = sessions.slice(0, limit);

    const result = limited.map((s) => ({
      sessionId: s.sessionId,
      description: s.description ?? '(no description)',
      source: s.source,
      messageCount: s.messageCount,
      lastActivity: s.lastActivityAt,
      createdAt: s.createdAt,
      lastMessagePreview: s.lastMessagePreview,
    }));

    return {
      content: asTextContent(
        result.length > 0
          ? formatJson(result)
          : 'No sessions found.\n',
      ),
      details: { count: result.length, total: sessions.length },
    };
  },
});

export const createSessionReadTool = (context: ToolContext): AgentTool<typeof SessionReadParams> => ({
  name: 'session_read',
  label: 'Read Session Messages',
  description: 'Read message history from a specified session. Returns recent user and assistant messages. Use this to review what happened in another session.',
  parameters: SessionReadParams,
  execute: async (_toolCallId, args: SessionReadArgs) => {
    if (!context.messageStore || !context.storeScope) {
      throw new ValidationError('session_read is unavailable: no message store is configured.');
    }

    const sessionId = args.session_id.trim();
    if (!sessionId) {
      throw new ValidationError('session_read requires a non-empty session_id.');
    }

    const limit = args.limit ?? 50;
    const messages = await context.messageStore.listRecentMessages(context.storeScope, sessionId, limit);

    if (messages.length === 0) {
      return {
        content: asTextContent(`No messages found in session ${sessionId}.\n`),
        details: { sessionId, count: 0 },
      };
    }

    const formatted = messages.map((m) => {
      const tag = m.role === 'user' ? '[USER]' : m.role === 'assistant' ? '[ASSISTANT]' : `[${m.role.toUpperCase()}]`;
      const preview = m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content;
      return `${m.ts} ${tag} ${preview}`;
    }).join('\n\n');

    return {
      content: asTextContent(`Session ${sessionId} — ${messages.length} messages:\n\n${formatted}\n`),
      details: { sessionId, count: messages.length },
    };
  },
});

export const createSessionSummaryTool = (context: ToolContext): AgentTool<typeof SessionSummaryParams> => ({
  name: 'session_summary',
  label: 'Session Summary',
  description: 'Get a summary of a session: description, working memory, message count, and recent activity. Useful for quickly understanding what happened in a session.',
  parameters: SessionSummaryParams,
  execute: async (_toolCallId, args: SessionSummaryArgs) => {
    if (!context.sessionStore || !context.messageStore || !context.storeScope) {
      throw new ValidationError('session_summary is unavailable: stores are not configured.');
    }

    const sessionId = args.session_id.trim();
    if (!sessionId) {
      throw new ValidationError('session_summary requires a non-empty session_id.');
    }

    const session = await context.sessionStore.get(context.storeScope, sessionId);
    if (!session) {
      throw new ValidationError(`Session not found: ${sessionId}`);
    }

    const workingMemory = await context.messageStore.getSessionWorkingMemory(context.storeScope, sessionId);
    const compactionSummary = await context.messageStore.getCompactionSummary(context.storeScope, sessionId);
    const recentMessages = await context.messageStore.listRecentMessages(context.storeScope, sessionId, 5);

    const parts: string[] = [];

    parts.push(`**Session:** ${sessionId}`);
    parts.push(`**Description:** ${session.description ?? '(none)'}`);
    parts.push(`**Source:** ${session.source.platform ?? session.source.kind}${session.source.interactive ? ' (interactive)' : ''}`);
    parts.push(`**Messages:** ${session.messageCount}`);
    parts.push(`**Created:** ${session.createdAt}`);
    parts.push(`**Last activity:** ${session.lastActivityAt}`);

    if (workingMemory) {
      parts.push(`\n**Working memory:**\n${workingMemory}`);
    }

    if (compactionSummary) {
      parts.push(`\n**Conversation summary:**\n${compactionSummary}`);
    }

    if (recentMessages.length > 0) {
      const recent = recentMessages.map((m) => {
        const tag = m.role === 'user' ? '[USER]' : m.role === 'assistant' ? '[ASSISTANT]' : `[${m.role.toUpperCase()}]`;
        const preview = m.content.length > 200 ? `${m.content.slice(0, 200)}…` : m.content;
        return `  ${tag} ${preview}`;
      }).join('\n');
      parts.push(`\n**Recent messages:**\n${recent}`);
    }

    return {
      content: asTextContent(`${parts.join('\n')}\n`),
      details: {
        sessionId,
        description: session.description,
        messageCount: session.messageCount,
        hasWorkingMemory: Boolean(workingMemory),
        hasCompactionSummary: Boolean(compactionSummary),
      },
    };
  },
});
