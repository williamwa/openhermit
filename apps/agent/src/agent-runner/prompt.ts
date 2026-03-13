import { promises as fs } from 'node:fs';

import type { AgentConfig, AgentSecurity, AgentWorkspace } from '../core/index.js';

const CONTAINER_TOOL_GUIDANCE = [
  'Container tool rules:',
  '- Container tools do not see the whole workspace. They only see the mounted subdirectory.',
  '- Valid mounts must stay under containers/{name}/data.',
  '- Files under files/ or the workspace root are not mounted automatically.',
  '- Before running code in a container, write or copy the needed files into the chosen mount directory first.',
  '- You may choose the in-container mount target. Defaults are /workspace for ephemeral runs and /data for service containers.',
  '- If a service expects files in a specific location, set mount_target explicitly, for example /usr/share/nginx/html for nginx static content.',
  '- If a container tool fails, inspect the tool result details and correct the mount or in-container path before retrying.',
].join('\n');

const RUNTIME_PROMPT_TEMPLATE_CANDIDATES = [
  new URL('../prompts/runtime-system.md', import.meta.url),
  new URL('../../src/prompts/runtime-system.md', import.meta.url),
];

const replacePromptTokens = (
  template: string,
  values: Record<string, string>,
): string =>
  Object.entries(values).reduce(
    (content, [key, value]) => content.replaceAll(`{${key}}`, value),
    template,
  );

const loadRuntimePromptTemplate = async (): Promise<string> => {
  for (const candidate of RUNTIME_PROMPT_TEMPLATE_CANDIDATES) {
    try {
      return await fs.readFile(candidate, 'utf8');
    } catch {
      // Try the next candidate so both tsx (src) and compiled dist can work.
    }
  }

  throw new Error('Unable to load runtime system prompt template.');
};

export const buildSystemPrompt = async (
  config: AgentConfig,
  workspace: AgentWorkspace,
  security: AgentSecurity,
): Promise<string> => {
  const identityFiles = await Promise.all(
    config.identity.files.map(async (relativePath) => ({
      relativePath,
      content: await workspace.readFile(relativePath).catch(() => ''),
    })),
  );
  const identitySections = identityFiles
    .map(
      ({ relativePath, content }) =>
        `File: ${relativePath}\n${content.trim() || '(empty)'}`,
    )
    .join('\n\n');
  const secretNames = security.listSecretNames();
  const promptTemplate = await loadRuntimePromptTemplate();

  return replacePromptTokens(promptTemplate, {
    autonomyLevel: security.getAutonomyLevel(),
    containerToolGuidance: CONTAINER_TOOL_GUIDANCE,
    identitySections,
    secretReference: secretNames.length > 0
      ? `Available secret names for tool calls: ${secretNames.join(', ')}. Secret values are never shown in the prompt.`
      : 'No secret names are currently configured.',
  }).trim();
};
