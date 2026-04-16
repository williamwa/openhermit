import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';

import {
  type Toolset,
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
} from './shared.js';

const InstructionReadParams = Type.Object({
  key: Type.Optional(
    Type.String({
      description:
        'Instruction key to read, for example "identity", "soul", or "agents". Omit to read all instruction entries.',
    }),
  ),
});

type InstructionReadArgs = Static<typeof InstructionReadParams>;

const InstructionUpdateParams = Type.Object({
  key: Type.String({
    description:
      'Instruction key to write, for example "identity", "soul", or "agents".',
  }),
  content: Type.String({
    description: 'The new content for this instruction entry (markdown).',
  }),
});

type InstructionUpdateArgs = Static<typeof InstructionUpdateParams>;

export const createInstructionReadTool = ({
  instructionStore,
  storeScope,
}: ToolContext): AgentTool<typeof InstructionReadParams> => ({
  name: 'instruction_read',
  label: 'Read Instruction',
  description:
    'Read your instruction definitions. Returns one entry by key, or all entries if key is omitted.',
  parameters: InstructionReadParams,
  execute: async (_callId, args: InstructionReadArgs) => {
    if (!instructionStore || !storeScope) {
      return {
        content: asTextContent('Instruction store is not available.'),
        details: {},
      };
    }

    if (args.key) {
      const entry = await instructionStore.get(storeScope, args.key);

      if (!entry) {
        return {
          content: asTextContent(`No instruction entry found for key: ${args.key}`),
          details: {},
        };
      }

      return {
        content: asTextContent(
          `# ${args.key}\n\n${entry.content}\n\n(updated: ${entry.updatedAt})`,
        ),
        details: { entry },
      };
    }

    const entries = await instructionStore.getAll(storeScope);

    if (entries.length === 0) {
      return {
        content: asTextContent('No instruction entries found.'),
        details: {},
      };
    }

    const text = entries
      .map((e) => `## ${e.key}\n\n${e.content}\n\n(updated: ${e.updatedAt})`)
      .join('\n\n---\n\n');

    return {
      content: asTextContent(text),
      details: { entries },
    };
  },
});

export const createInstructionUpdateTool = ({
  security,
  instructionStore,
  storeScope,
}: ToolContext): AgentTool<typeof InstructionUpdateParams> => ({
  name: 'instruction_update',
  label: 'Update Instruction',
  description:
    'Update an instruction entry. Use this to refine your identity, soul, or collaboration rules.',
  parameters: InstructionUpdateParams,
  execute: async (_callId, args: InstructionUpdateArgs) => {
    ensureAutonomyAllows(security, 'instruction_update');

    if (!instructionStore || !storeScope) {
      return {
        content: asTextContent('Instruction store is not available.'),
        details: {},
      };
    }

    const updatedAt = new Date().toISOString();
    await instructionStore.set(storeScope, args.key, args.content, updatedAt);

    return {
      content: asTextContent(
        `Instruction entry "${args.key}" updated successfully.`,
      ),
      details: { key: args.key, updatedAt },
    };
  },
});

// ── Toolset ────────────────────────────────────────────────────────

const INSTRUCTION_DESCRIPTION = `\
### Instructions Management

Your specific identity, role, style, and priorities are defined by the instruction entries below. Treat them as the authoritative description of who you are, unless they conflict with system safety or tool constraints.
If the user wants to change your name, role, style, or other instructions, use the \`instruction_update\` tool to persist the change. Use \`instruction_read\` to review current entries. Do not edit instruction files on disk directly.`;

export const createInstructionToolset = (context: ToolContext): Toolset => ({
  id: 'instruction',
  description: INSTRUCTION_DESCRIPTION,
  tools: [
    createInstructionReadTool(context),
    createInstructionUpdateTool(context),
  ],
});
