import { getProviders, getModels } from '@mariozechner/pi-ai';

export interface ProviderCatalogEntry {
  provider: string;
  models: { id: string; reasoning: boolean }[];
}

/**
 * Snapshot of the providers and models registered in pi-ai. Used by
 * the admin UI / web client to populate cascading provider+model
 * pickers without baking the registry into the frontend.
 *
 * `reasoning` is the per-model capability flag from pi-ai (true for
 * thinking-only / thinking-capable models). The UI uses it to surface
 * a warning when a user explicitly disables thinking on a model that
 * needs it server-side.
 */
export const listProviderCatalog = (): ProviderCatalogEntry[] => {
  const providers = getProviders();
  return providers.map((provider) => ({
    provider,
    models: getModels(provider).map((m) => ({
      id: m.id,
      reasoning: Boolean((m as { reasoning?: boolean }).reasoning),
    })),
  }));
};
