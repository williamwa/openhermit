import { useEffect, useMemo, useState } from 'react';
import {
  fetchAgentConfig,
  putAgentConfig,
  fetchProviderCatalog,
  fetchAgentSecrets,
  type AgentConfig,
  type ProviderCatalogEntry,
} from '../api';

/**
 * Convention pi-ai uses to look up an API key for a provider:
 * `<UPPERCASE_NAME>_API_KEY`, with non-alphanumerics replaced by `_`.
 * A few providers have curated alternate names (e.g. google).
 */
const candidateSecretNames = (provider: string): string[] => {
  const upper = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
  const extras: Record<string, string[]> = {
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  };
  return extras[provider] ?? [upper];
};

const providerHasKey = (
  provider: string,
  secrets: Record<string, string>,
): boolean => candidateSecretNames(provider).some((name) => Boolean(secrets[name]));

type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high';

const THINKING_LEVELS: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high'];
const CUSTOM = '__custom__';

export function BasicPanel() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [provider, setProvider] = useState('');
  const [providerMode, setProviderMode] = useState<'preset' | 'custom'>('preset');
  const [model, setModel] = useState('');
  const [modelMode, setModelMode] = useState<'preset' | 'custom'>('preset');
  const [thinking, setThinking] = useState<Thinking | ''>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      fetchAgentConfig(),
      fetchProviderCatalog(),
      fetchAgentSecrets().catch(() => ({} as Record<string, string>)),
    ])
      .then(([c, cat, sec]) => {
        setConfig(c);
        setCatalog(cat);
        setSecrets(sec);
        const initialProvider = c.model?.provider ?? '';
        setProvider(initialProvider);
        // If the existing provider isn't in the catalog, drop the user
        // straight into custom mode so they can edit the free-text value.
        const isKnownProvider = cat.some((e) => e.provider === initialProvider);
        setProviderMode(isKnownProvider || !initialProvider ? 'preset' : 'custom');
        const initialModel = c.model?.model ?? '';
        setModel(initialModel);
        const knownModelsForProvider = cat.find((e) => e.provider === initialProvider)?.models ?? [];
        const isKnownModel = knownModelsForProvider.some((m) => m.id === initialModel);
        setModelMode(isKnownModel || !initialModel ? 'preset' : 'custom');
        setThinking((c.model?.thinking as Thinking) ?? '');
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const modelsForProvider = useMemo(() => {
    return catalog.find((e) => e.provider === provider)?.models ?? [];
  }, [catalog, provider]);

  const dirty = config != null && (
    provider !== (config.model?.provider ?? '')
    || model !== (config.model?.model ?? '')
    || thinking !== ((config.model?.thinking as Thinking | undefined) ?? '')
  );

  const handleSave = async () => {
    if (!config || !provider.trim() || !model.trim()) return;
    setSaving(true);
    setError('');
    try {
      const next: AgentConfig = {
        ...config,
        model: {
          ...config.model,
          provider: provider.trim(),
          model: model.trim(),
          ...(thinking ? { thinking } : {}),
        },
      };
      if (!thinking && next.model.thinking) {
        delete (next.model as Record<string, unknown>).thinking;
      }
      await putAgentConfig(next);
      setConfig(next);
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="manage__empty">Loading…</p>;
  if (error && !config) return <p className="manage__empty">{error}</p>;
  if (!config) return null;

  return (
    <div className="basic-panel">
      <div className="basic-panel__intro">
        <p className="eyebrow">Model</p>
        <p className="basic-panel__hint">
          Provider, model id, and thinking level. Other config (exec backend,
          memory, channels) remains unchanged.
        </p>
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-provider">Provider</label>
        {providerMode === 'preset' ? (
          <select
            id="basic-provider"
            value={catalog.some((e) => e.provider === provider) ? provider : ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value === CUSTOM) {
                setProviderMode('custom');
                return;
              }
              setProvider(value);
              // When switching provider via the dropdown, clear the model
              // so the user picks one from the new provider's list, and
              // return the model field to preset mode in case they were
              // previously in custom mode.
              if (value !== provider) {
                setModel('');
                setModelMode('preset');
              }
            }}
          >
            <option value="">— pick a provider —</option>
            {catalog.map((e) => (
              <option key={e.provider} value={e.provider}>
                {providerHasKey(e.provider, secrets) ? '✓' : '✗'} {e.provider} ({e.models.length})
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        ) : (
          <div className="basic-panel__custom-row">
            <input
              id="basic-provider"
              type="text"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="e.g. my-self-hosted-provider"
              autoComplete="off"
            />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                setProviderMode('preset');
                if (!catalog.some((e) => e.provider === provider)) {
                  setProvider('');
                  setModel('');
                }
              }}
            >
              Pick from list
            </button>
          </div>
        )}
        {provider && (
          providerHasKey(provider, secrets) ? (
            <p className="basic-panel__hint basic-panel__hint--ok">
              ✓ API key set: {candidateSecretNames(provider).find((n) => secrets[n]) ?? ''}
            </p>
          ) : (
            <p className="basic-panel__hint basic-panel__hint--warn">
              ✗ No API key. Add <code>{candidateSecretNames(provider)[0]}</code> in the Secrets tab.
            </p>
          )
        )}
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-model">Model</label>
        {modelMode === 'preset' && modelsForProvider.length > 0 ? (
          <select
            id="basic-model"
            value={modelsForProvider.some((m) => m.id === model) ? model : ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value === CUSTOM) {
                setModelMode('custom');
                return;
              }
              setModel(value);
            }}
          >
            <option value="">— pick a model —</option>
            {modelsForProvider.map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        ) : (
          <div className="basic-panel__custom-row">
            <input
              id="basic-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={modelsForProvider[0]?.id ?? 'e.g. claude-sonnet-4-6'}
              autoComplete="off"
            />
            {modelsForProvider.length > 0 && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => {
                  setModelMode('preset');
                  if (!modelsForProvider.some((m) => m.id === model)) setModel('');
                }}
              >
                Pick from list
              </button>
            )}
          </div>
        )}
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-thinking">Thinking</label>
        <select
          id="basic-thinking"
          value={thinking}
          onChange={(e) => setThinking(e.target.value as Thinking | '')}
        >
          <option value="">— default —</option>
          {THINKING_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>{lvl}</option>
          ))}
        </select>
      </div>

      {error && config && <p className="basic-panel__error">{error}</p>}

      <div className="basic-panel__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={saving || !dirty || !provider.trim() || !model.trim()}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && !dirty && (
          <span className="basic-panel__saved">Saved at {savedAt}</span>
        )}
      </div>
    </div>
  );
}
