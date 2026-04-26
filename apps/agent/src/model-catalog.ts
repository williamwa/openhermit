import { getProviders, getModels } from '@mariozechner/pi-ai';

export interface ProviderCatalogEntry {
  provider: string;
  models: { id: string }[];
}

/**
 * Snapshot of the providers and models registered in pi-ai. Used by
 * the admin UI / web client to populate cascading provider+model
 * pickers without baking the registry into the frontend.
 */
export const listProviderCatalog = (): ProviderCatalogEntry[] => {
  const providers = getProviders();
  return providers.map((provider) => ({
    provider,
    models: getModels(provider).map((m) => ({ id: m.id })),
  }));
};
