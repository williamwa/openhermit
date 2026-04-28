import { readFileSync } from 'node:fs';

import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

const resolveAgent = (opts: { agent?: string }): string => {
  return opts.agent ?? process.env.OPENHERMIT_AGENT_ID ?? 'main';
};

const ensureNotBoth = (opts: { agent?: string; all?: boolean }): void => {
  if (opts.agent && opts.all) {
    console.error('Pass either --agent <id> or --all, not both.');
    process.exit(1);
  }
};

const readContent = (
  inline: string | undefined,
  file: string | undefined,
  required: boolean,
): string | undefined => {
  if (file) {
    return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  }
  if (inline !== undefined) return inline;
  if (required) {
    console.error('Provide content as the second argument or use --file.');
    process.exit(1);
  }
  return undefined;
};

const printFanoutResult = (verb: string, key: string, agents: string[]): void => {
  console.log(`${verb} "${key}" on ${agents.length} agent(s):`);
  for (const a of agents) console.log(`  - ${a}`);
};

export const registerInstructionsCommand = (program: Command): void => {
  const cmd = program
    .command('instructions')
    .description('Manage agent instructions (the keyed sections of the system prompt). Each command targets a single agent (--agent) or fans out to every agent (--all, admin only).');

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
    .description('Replace an instruction. Targets one agent (--agent) or every agent (--all, admin).')
    .argument('<key>', 'Instruction key')
    .argument('[content]', 'Instruction content (omit when using --file)')
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .option('--all', 'Apply to every registered agent (admin only)')
    .option('--file <path>', 'Read content from a file (use "-" for stdin)')
    .action(async (key: string, content: string | undefined, opts: { agent?: string; all?: boolean; file?: string }) => {
      try {
        ensureNotBoth(opts);
        const value = readContent(content, opts.file, true)!;
        const gateway = createGateway();
        if (opts.all) {
          const result = await gateway.fanoutInstruction({ mode: 'set', key, content: value });
          printFanoutResult('Set', key, result.agents);
        } else {
          const agent = resolveAgent(opts);
          await gateway.setInstruction(agent, key, value);
          console.log(`Set instruction "${key}" for agent ${agent}.`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('append')
    .description('Append a line to an existing instruction (creating the row if missing). Targets one agent (--agent) or every agent (--all, admin).')
    .argument('<key>', 'Instruction key')
    .argument('[content]', 'Line to append (omit when using --file)')
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .option('--all', 'Apply to every registered agent (admin only)')
    .option('--file <path>', 'Read content from a file (use "-" for stdin)')
    .action(async (key: string, content: string | undefined, opts: { agent?: string; all?: boolean; file?: string }) => {
      try {
        ensureNotBoth(opts);
        const value = readContent(content, opts.file, true)!;
        const gateway = createGateway();
        if (opts.all) {
          const result = await gateway.fanoutInstruction({ mode: 'append', key, content: value });
          printFanoutResult('Appended to', key, result.agents);
        } else {
          // Per-agent append: read existing, append, write back.
          const agent = resolveAgent(opts);
          const existing = await gateway.getInstruction(agent, key);
          const next = existing && existing.content.length > 0
            ? `${existing.content.replace(/\s+$/, '')}\n${value}`
            : value;
          await gateway.setInstruction(agent, key, next);
          console.log(`Appended to instruction "${key}" for agent ${agent}.`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  cmd
    .command('remove')
    .alias('delete')
    .description('Remove an instruction. Targets one agent (--agent) or every agent (--all, admin).')
    .argument('<key>', 'Instruction key')
    .option('--agent <id>', 'Agent ID. Defaults to OPENHERMIT_AGENT_ID or "main".')
    .option('--all', 'Apply to every registered agent (admin only)')
    .action(async (key: string, opts: { agent?: string; all?: boolean }) => {
      try {
        ensureNotBoth(opts);
        const gateway = createGateway();
        if (opts.all) {
          const result = await gateway.fanoutInstruction({ mode: 'remove', key });
          printFanoutResult('Removed', key, result.agents);
        } else {
          const agent = resolveAgent(opts);
          await gateway.deleteInstruction(agent, key);
          console.log(`Removed instruction "${key}" for agent ${agent}.`);
        }
      } catch (error) {
        handleError(error);
      }
    });
};
