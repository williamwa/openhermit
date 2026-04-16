import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';

import {
  type Toolset,
  type ToolContext,
  asTextContent,
  ensureAutonomyAllows,
} from './shared.js';

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

Your specific identity, role, style, and priorities are defined by the instruction entries in the Instructions section above. Treat them as the authoritative description of who you are, unless they conflict with system safety or tool constraints.
If the user wants to change your name, role, style, or other instructions, use the \`instruction_update\` tool to persist the change. Do not edit instruction files on disk directly.`;

export const createInstructionToolset = (context: ToolContext): Toolset => ({
  id: 'instruction',
  description: INSTRUCTION_DESCRIPTION,
  tools: [
    createInstructionUpdateTool(context),
  ],
});
