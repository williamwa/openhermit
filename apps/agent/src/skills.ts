/**
 * Skill index loading: merges DB-enabled skills with workspace-scanned skills.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { SkillStore } from '@openhermit/store';

import { AGENT_CONTAINER_HOME } from './core/types.js';

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  /** Container-side path (e.g. /skills/<id> or {AGENT_CONTAINER_HOME}/.openhermit/skills/<id>) */
  path: string;
  source: 'system' | 'workspace';
}

/** Parse YAML frontmatter from a SKILL.md file. */
export const parseFrontmatter = (content: string): Record<string, string> => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    result[key] = value;
  }
  return result;
};

/**
 * Scan a directory for SKILL.md files and return index entries.
 * Expects: `baseDir/<skillId>/SKILL.md`
 */
export const scanSkillDirectory = async (
  baseDir: string,
  containerBasePath: string,
  source: 'system' | 'workspace',
): Promise<SkillIndexEntry[]> => {
  let entries: string[];
  try {
    entries = await readdir(baseDir, { withFileTypes: true }).then(
      (dirents) => dirents.filter((d) => d.isDirectory()).map((d) => d.name),
    );
  } catch {
    return []; // Directory doesn't exist — no skills here.
  }

  const skills: SkillIndexEntry[] = [];
  for (const dirName of entries) {
    const skillMdPath = path.join(baseDir, dirName, 'SKILL.md');
    try {
      const content = await readFile(skillMdPath, 'utf8');
      const fm = parseFrontmatter(content);
      const name = fm.name || dirName;
      const description = fm.description || '';
      if (!description) continue; // Skip skills without a description.
      skills.push({
        id: dirName,
        name,
        description,
        path: `${containerBasePath}/${dirName}`,
        source,
      });
    } catch {
      // SKILL.md not readable — skip.
    }
  }
  return skills;
};

/**
 * Load the effective skill index for an agent by merging:
 * 1. DB-enabled skills (system/owner-managed, mounted at /skills/)
 * 2. Workspace-scanned skills ({AGENT_CONTAINER_HOME}/.openhermit/skills/)
 * 3. Built-in skills (project repo skills/ directory)
 *
 * Higher-numbered sources won't override lower-numbered ones.
 */
export const loadSkillIndex = async (
  agentId: string,
  workspaceRoot: string,
  skillStore?: SkillStore,
): Promise<SkillIndexEntry[]> => {
  const entries = new Map<string, SkillIndexEntry>();

  // 1. DB-enabled skills (higher priority)
  if (skillStore) {
    const dbSkills = await skillStore.listEnabled(agentId);
    for (const skill of dbSkills) {
      entries.set(skill.id, {
        id: skill.id,
        name: skill.name,
        description: skill.description,
        path: `/skills/${skill.id}`,
        source: 'system',
      });
    }
  }

  // 2. Workspace skills (won't override DB skills)
  const workspaceSkillsDir = path.join(workspaceRoot, '.openhermit', 'skills');
  const wsSkills = await scanSkillDirectory(
    workspaceSkillsDir,
    `${AGENT_CONTAINER_HOME}/.openhermit/skills`,
    'workspace',
  );
  for (const skill of wsSkills) {
    if (!entries.has(skill.id)) {
      entries.set(skill.id, skill);
    }
  }

  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * Format the skill index as a system prompt section.
 * Returns undefined if no skills are available.
 */
export const formatSkillsPromptSection = (skills: SkillIndexEntry[]): string | undefined => {
  if (skills.length === 0) return undefined;

  const lines = skills.map(
    (s) => `- **${s.name}**: ${s.description} — \`cat ${s.path}/SKILL.md\``,
  );

  return `## Skills

The following skills provide specialized instructions for specific tasks. When a task matches a skill's description, read its SKILL.md for detailed instructions.

${lines.join('\n')}`;
};
