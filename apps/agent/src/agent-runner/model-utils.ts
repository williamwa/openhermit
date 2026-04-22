import { getModel, type Model } from '@mariozechner/pi-ai';

import { ValidationError } from '@openhermit/shared';

import type { AgentConfig } from '../core/index.js';

const SECRET_NAME_CANDIDATES: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  zai: ['ZAI_API_KEY'],
  exa: ['EXA_API_KEY'],
  tavily: ['TAVILY_API_KEY'],
};

export const createProviderSecretCandidates = (provider: string): string[] => {
  const configured = SECRET_NAME_CANDIDATES[provider];

  if (configured) {
    return configured;
  }

  return [`${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`];
};

export const formatMissingApiKeyMessage = (
  provider: string,
  secretsFilePath: string,
): string => {
  const candidateNames = createProviderSecretCandidates(provider);

  return [
    `Missing API key for provider "${provider}".`,
    `Add one of [${candidateNames.join(', ')}] to ${secretsFilePath}, or export it in the environment before starting the agent.`,
  ].join(' ');
};

const OPENAI_COMPATIBLE_PROVIDERS: Record<string, { api: string; baseUrl: string }> = {
  openrouter: { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1' },
};

export const resolveModel = (config: AgentConfig): Model<any> => {
  const providerDefaults = OPENAI_COMPATIBLE_PROVIDERS[config.model.provider];
  const api = config.model.api ?? providerDefaults?.api;
  const baseUrl = config.model.base_url ?? providerDefaults?.baseUrl;

  if (api && baseUrl) {
    return {
      id: config.model.model,
      name: config.model.model,
      api,
      provider: config.model.provider,
      baseUrl,
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: config.model.max_tokens,
    } as Model<any>;
  }

  try {
    const model = getModel(
      config.model.provider as never,
      config.model.model as never,
    ) as Model<any>;

    if (config.model.base_url) {
      return { ...model, baseUrl: config.model.base_url };
    }

    return model;
  } catch {
    throw new ValidationError(
      `Unsupported model configuration: ${config.model.provider}/${config.model.model}`,
    );
  }
};
