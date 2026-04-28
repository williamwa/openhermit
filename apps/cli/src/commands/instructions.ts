import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

const resolveAgent = (opts: { agent?: string }): string => {
  return opts.agent ?? process.env.OPENHERMIT_AGENT_ID ?? 'main';
};

const targetLabel = (agent: string): string =>
  agent === '*' ? 'all agents (global)' : `agent ${agent}`;

export const registerInstructionsCommand = (program: Command): void => {
  const cmd = program
    .command('instructions')
    .description('Manage agent instructions (use --agent "*" for global instructions)');

  cmd
    .command('list')
    .description('List instructions for an agent. Defaults to per-agent rows; use --merged to see effective set including globals.')
    .option('--agent <id>', 'Agent ID, or "*" for global. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .option('--merged', 'Include global rows merged in (per-agent overrides global on key collision)')
    .action(async (opts: { agent?: string; merged?: boolean }) => {
      try {
        const agent = resolveAgent(opts);
        const gateway = createGateway();
        const rows = await gateway.listInstructions(agent, opts.merged ? { merged: true } : undefined);
        if (rows.length === 0) {
          console.log(`No instructions for ${targetLabel(agent)}.`);
          return;
        }
        printTable(
          rows.map((r) => ({
            key: r.key,
            preview: r.content.length > 60 ? r.content.slice(0, 60) + '…' : r.content,
            updatedAt: r.updatedAt,
          })),
          [
            { key: 'key', label: 'Key', width: 20 },
            { key: 'preview', label: 'Content' },
            { key: 'updatedAt', label: 'Updated', width: 26 },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('get')
    .description('Print the full content of one instruction')
    .argument('<key>', 'Instruction key')
    .option('--agent <id>', 'Agent ID, or "*" for global. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .action(async (key: string, opts: { agent?: string }) => {
      try {
        const agent = resolveAgent(opts);
        const gateway = createGateway();
        const row = await gateway.getInstruction(agent, key);
        if (!row) {
          console.error(`Instruction "${key}" not found for ${targetLabel(agent)}.`);
          process.exit(1);
        }
        console.log(row.content);
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('set')
    .description('Set or replace an instruction (provide content inline or with --file)')
    .argument('<key>', 'Instruction key')
    .argument('[content]', 'Instruction content (omit when using --file)')
    .option('--agent <id>', 'Agent ID, or "*" for global. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .option('--file <path>', 'Read content from a file (use "-" for stdin)')
    .action(async (key: string, content: string | undefined, opts: { agent?: string; file?: string }) => {
      try {
        const agent = resolveAgent(opts);
        let value: string;
        if (opts.file) {
          value = opts.file === '-'
            ? readFileSync(0, 'utf8')
            : readFileSync(opts.file, 'utf8');
        } else if (content !== undefined) {
          value = content;
        } else {
          console.error('Provide content as the second argument or use --file.');
          process.exit(1);
        }
        const gateway = createGateway();
        await gateway.setInstruction(agent, key, value);
        console.log(`Set instruction "${key}" for ${targetLabel(agent)}.`);
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('remove')
    .alias('delete')
    .description('Remove an instruction')
    .argument('<key>', 'Instruction key')
    .option('--agent <id>', 'Agent ID, or "*" for global. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .action(async (key: string, opts: { agent?: string }) => {
      try {
        const agent = resolveAgent(opts);
        const gateway = createGateway();
        await gateway.deleteInstruction(agent, key);
        console.log(`Removed instruction "${key}" for ${targetLabel(agent)}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
