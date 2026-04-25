import type { Command } from 'commander';

import { createGateway, handleError, printTable } from './shared.js';

export const registerSkillsCommand = (program: Command): void => {
  const skills = program
    .command('skills')
    .description('Manage skills (use --agent "*" to target all agents)');

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
    .description('Enable a skill for an agent (use --agent "*" for all agents)')
    .argument('<skillId>', 'Skill ID')
    .requiredOption('--agent <id>', 'Agent ID, or "*" for all agents')
    .action(async (skillId: string, opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        await gateway.enableSkill(skillId, opts.agent);
        const target = opts.agent === '*' ? 'all agents' : `agent ${opts.agent}`;
        console.log(`Enabled skill ${skillId} for ${target}.`);
      } catch (error) {
        handleError(error);
      }
    });

  skills
    .command('disable')
    .description('Disable a skill for an agent (use --agent "*" for all agents)')
    .argument('<skillId>', 'Skill ID')
    .requiredOption('--agent <id>', 'Agent ID, or "*" for all agents')
    .action(async (skillId: string, opts: { agent: string }) => {
      try {
        const gateway = createGateway();
        await gateway.disableSkill(skillId, opts.agent);
        const target = opts.agent === '*' ? 'all agents' : `agent ${opts.agent}`;
        console.log(`Disabled skill ${skillId} for ${target}.`);
      } catch (error) {
        handleError(error);
      }
    });
};
