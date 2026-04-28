import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerSkillsCommand = (program: Command): void => {
  const skills = program
    .command('skills')
    .description('Manage skills');

  /** Resolve --agent | --all into the wildcard-or-id the API expects. */
  const resolveTarget = (opts: { agent?: string; all?: boolean }): string => {
    if (opts.agent && opts.all) {
      console.error('Pass either --agent <id> or --all, not both.');
      process.exit(1);
    }
    if (opts.all) return '*';
    if (opts.agent) return opts.agent;
    console.error('Pass --agent <id> or --all.');
    process.exit(1);
  };
  const targetLabel = (target: string): string =>
    target === '*' ? 'all agents' : `agent ${target}`;

  skills
    .command('list')
    .description('List all skills in the registry')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = (await gateway.listSkills()) as any[];
        if (list.length === 0) {
          console.log('No skills registered.');
          return;
        }
        printTable(
          list.map((s: any) => ({
            id: s.id,
            name: s.name ?? '',
            source: s.source ?? '',
            description: s.description
              ? (s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description)
              : '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'source', label: 'Source', width: 10 },
            { key: 'description', label: 'Description' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('assignments')
    .description('List skill assignments (which skills are enabled for which agents)')
    .action(async () => {
      try {
        const gateway = createGateway();
        const list = await gateway.listSkillAssignments();
        if (list.length === 0) {
          console.log('No skill assignments.');
          return;
        }
        printTable(
          list.map((a) => ({
            agentId: a.agentId,
            skillId: a.skillId,
            enabled: a.enabled ? 'yes' : 'no',
          })),
          [
            { key: 'agentId', label: 'Agent', width: 16 },
            { key: 'skillId', label: 'Skill' },
            { key: 'enabled', label: 'Enabled', width: 8 },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('enable')
    .description('Enable a skill. Targets one agent (--agent) or every agent (--all).')
    .argument('<skillId>', 'Skill ID')
    .option('--agent <id>', 'Agent ID')
    .option('--all', 'Apply to every agent (writes a wildcard assignment row)')
    .action(async (skillId: string, opts: { agent?: string; all?: boolean }) => {
      try {
        const target = resolveTarget(opts);
        const gateway = createGateway();
        await gateway.enableSkill(skillId, target);
        console.log(`Enabled skill ${skillId} for ${targetLabel(target)}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('disable')
    .description('Disable a skill. Targets one agent (--agent) or every agent (--all).')
    .argument('<skillId>', 'Skill ID')
    .option('--agent <id>', 'Agent ID')
    .option('--all', 'Apply to every agent (removes the wildcard assignment row)')
    .action(async (skillId: string, opts: { agent?: string; all?: boolean }) => {
      try {
        const target = resolveTarget(opts);
        const gateway = createGateway();
        await gateway.disableSkill(skillId, target);
        console.log(`Disabled skill ${skillId} for ${targetLabel(target)}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('scan')
    .description('Scan the gateway skills directory for skill manifests')
    .action(async () => {
      try {
        const gateway = createGateway();
        const found = (await gateway.scanSkills()) as any[];
        if (found.length === 0) {
          console.log('No skills found.');
          return;
        }
        printTable(
          found.map((s: any) => ({
            id: s.id,
            name: s.name ?? '',
            path: s.path ?? '',
            description: s.description
              ? (s.description.length > 60 ? s.description.slice(0, 60) + '…' : s.description)
              : '',
          })),
          [
            { key: 'id', label: 'ID' },
            { key: 'name', label: 'Name' },
            { key: 'path', label: 'Path' },
            { key: 'description', label: 'Description' },
          ],
        );
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('register <skillId>')
    .description('Register a skill in the global registry')
    .requiredOption('--name <name>', 'Display name')
    .requiredOption('--description <text>', 'Skill description')
    .requiredOption('--path <path>', 'Filesystem path to skill directory')
    .action(async (skillId: string, opts: { name: string; description: string; path: string }) => {
      try {
        const gateway = createGateway();
        await gateway.registerSkill({
          id: skillId,
          name: opts.name,
          description: opts.description,
          path: opts.path,
        });
        console.log(`Registered skill ${skillId}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('delete <skillId>')
    .description('Delete a skill from the global registry')
    .action(async (skillId: string) => {
      try {
        const gateway = createGateway();
        await gateway.deleteSkill(skillId);
        console.log(`Deleted skill ${skillId}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
