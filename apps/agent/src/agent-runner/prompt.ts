import { promises as fs } from 'node:fs';
import type { InstructionStore, StoreScope } from '@openhermit/store';

import type { AgentRuntimeConfig, AgentSecurity } from '../core/index.js';

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

export interface InstructionSource {
  instructionStore?: InstructionStore;
  storeScope?: StoreScope;
}

export const buildSystemPrompt = async (
  config: AgentRuntimeConfig,
  security: AgentSecurity,
  instructionSource?: InstructionSource,
): Promise<string> => {
  let instructionSections: string;

  if (instructionSource?.instructionStore && instructionSource.storeScope) {
    const entries = await instructionSource.instructionStore.getAll(instructionSource.storeScope);
    instructionSections = entries
      .map((entry) => `${entry.key}:\n${entry.content.trim() || '(empty)'}`)
      .join('\n\n');
  } else {
    instructionSections = '(no instructions configured)';
  }
  const secretNames = security.listSecretNames();
  const promptTemplate = await loadRuntimePromptTemplate();
  return replacePromptTokens(promptTemplate, {
    autonomyLevel: security.getAutonomyLevel(),
    instructionSections,
    secretReference: secretNames.length > 0
      ? `Available secret names for tool calls: ${secretNames.join(', ')}. Secret values are never shown in the prompt.`
      : 'No secret names are currently configured.',
  }).trim();
};
