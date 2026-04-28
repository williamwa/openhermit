import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

const resolveAgent = (opts: { agent?: string }): string => {
  return opts.agent ?? process.env.OPENHERMIT_AGENT_ID ?? 'main';
};

export const registerInstructionsCommand = (program: Command): void => {
  const cmd = program
    .command('instructions')
    .description('Manage agent instructions (the keyed sections of the system prompt)');

  cmd
    .command('list')
    .description('List instructions for an agent')
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .action(async (opts: { agent?: string }) => {
      try {
        const agent = resolveAgent(opts);
        const gateway = createGateway();
        const rows = await gateway.listInstructions(agent);
        if (rows.length === 0) {
          console.log(`No instructions for agent ${agent}.`);
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
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .action(async (key: string, opts: { agent?: string }) => {
      try {
        const agent = resolveAgent(opts);
        const gateway = createGateway();
        const row = await gateway.getInstruction(agent, key);
        if (!row) {
          console.error(`Instruction "${key}" not found for agent ${agent}.`);
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
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
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
        console.log(`Set instruction "${key}" for agent ${agent}.`);
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('remove')
    .alias('delete')
    .description('Remove an instruction')
    .argument('<key>', 'Instruction key')
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .action(async (key: string, opts: { agent?: string }) => {
      try {
        const agent = resolveAgent(opts);
        const gateway = createGateway();
        await gateway.deleteInstruction(agent, key);
        console.log(`Removed instruction "${key}" for agent ${agent}.`);
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('append')
    .description('Append a line to <key> on every registered agent (admin only). Creates the row if missing.')
    .requiredOption('--key <key>', 'Instruction key (e.g. rules, tone)')
    .option('--content <text>', 'Content to append')
    .option('--file <path>', 'Read content from a file (use "-" for stdin)')
    .action(async (opts: { key: string; content?: string; file?: string }) => {
      try {
        let content: string;
        if (opts.file) {
          content = opts.file === '-'
            ? readFileSync(0, 'utf8')
            : readFileSync(opts.file, 'utf8');
        } else if (opts.content) {
          content = opts.content;
        } else {
          console.error('Provide --content or --file.');
          process.exit(1);
        }
        const gateway = createGateway();
        const result = await gateway.appendInstructionToAll(opts.key, content);
        console.log(`Appended to "${opts.key}" on ${result.agents.length} agent(s):`);
        for (const a of result.agents) console.log(`  - ${a}`);
      } catch (error) {
        handleError(error);
      }
    });
};
