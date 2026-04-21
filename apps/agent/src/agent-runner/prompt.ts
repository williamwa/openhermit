import type { SessionType } from '@openhermit/protocol';
import type { InstructionStore, StoreScope } from '@openhermit/store';

import type { AgentRuntimeConfig, AgentSecurity } from '../core/index.js';
import type { Toolset } from '../tools/shared.js';

// ── Prompt sections ──────────────────────────────────────────────────

const PREAMBLE = `\
You are an AI agent with your own persistent identity, name, and personality — defined by the instructions below.

You have an owner who configured and manages you. You may also interact with other users your owner has granted access to. Always be aware of who you are talking to and what your relationship with them is — check the "Current User" section for the current conversation partner.

Your primary job is to help your owner and authorized users accomplish real tasks safely and effectively.`;

const PRINCIPLES = `\
## Principles

- Built-in tools are execution primitives, not product goals. Use them to accomplish user tasks, don't present them as features.
- If a tool fails, read the error carefully and fix the specific issue before retrying.
- When in readonly mode, write operations are blocked — don't attempt them.`;

// ── Prompt builder ───────────────────────────────────────────────────

export interface CurrentUserContext {
  userId: string;
  role: import('@openhermit/store').UserRole;
  name?: string;
  sessionType?: SessionType;
}

export interface InstructionSource {
  instructionStore?: InstructionStore;
  storeScope?: StoreScope;
}

export const buildSystemPrompt = async (
  config: AgentRuntimeConfig,
  security: AgentSecurity,
  toolsets: Toolset[],
  instructionSource?: InstructionSource,
  currentUser?: CurrentUserContext,
): Promise<string> => {
  const sections: string[] = [];

  // 1. PREAMBLE
  sections.push(PREAMBLE);

  // 2. INSTRUCTIONS (from store)
  let instructionText: string;
  if (instructionSource?.instructionStore && instructionSource.storeScope) {
    const entries = await instructionSource.instructionStore.getAll(instructionSource.storeScope);
    instructionText = entries
      .map((entry) => `${entry.key}:\n${entry.content.trim() || '(empty)'}`)
      .join('\n\n');
  } else {
    instructionText = '(no instructions configured)';
  }
  sections.push(`## Instructions\n\n${instructionText}`);

  // 3. PRINCIPLES
  sections.push(PRINCIPLES);

  // 4. TOOLSET DESCRIPTIONS
  const descriptions = toolsets
    .filter((ts) => ts.description)
    .map((ts) => ts.description);
  if (descriptions.length > 0) {
    sections.push(`## Tools\n\n${descriptions.join('\n\n')}`);
  }

  // 5. CONTEXT
  const contextParts: string[] = [];

  if (currentUser) {
    const namePart = currentUser.name ? ` (${currentUser.name})` : '';
    if (currentUser.sessionType === 'group') {
      contextParts.push(
        `### Current User\n\nThis is a **group conversation**. The most recent message is from user \`${currentUser.userId}\`${namePart}, role: **${currentUser.role}**.\n\nMultiple users participate in this session. Each user message is prefixed with the sender's name in brackets (e.g. \`[Alice] hello\`). Use the sender's user ID for per-user memories (e.g. \`user/${currentUser.userId}/preferences\`).\n\nRemember: information about yourself (the agent) belongs under \`agent/…\`, not \`user/…\`.\n\n### Group Reply Policy\n\nNot every message in a group chat requires a response from you. Messages prefixed with \`[not directed at you]\` were sent without mentioning or replying to you.\n\n- If you are **mentioned** or **replied to**, always respond normally.\n- If a message is **not directed at you**, only respond if you have something genuinely useful to contribute. Otherwise, respond with exactly \`<NO_REPLY>\` and nothing else — this will be silently discarded.\n- When in doubt, prefer \`<NO_REPLY>\` over an unnecessary interruption.`,
      );
    } else {
      contextParts.push(
        `### Current User\n\nYou are talking to user \`${currentUser.userId}\`${namePart}, role: **${currentUser.role}**.\n\nUse this ID when storing or recalling per-user memories (e.g. \`user/${currentUser.userId}/preferences\`). At the start of a conversation, proactively recall memories under \`user/${currentUser.userId}/\` to personalize your responses.\n\nRemember: information about yourself (the agent) belongs under \`agent/…\`, not \`user/…\`.`,
      );
    }
  }

  contextParts.push(`### Runtime\n\nAutonomy level: ${security.getAutonomyLevel()}`);

  sections.push(`## Context\n\n${contextParts.join('\n\n')}`);

  // 6. TASK INSTRUCTIONS appended by caller (extraSystemPrompt)

  return sections.join('\n\n').trim();
};
