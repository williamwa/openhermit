import { useEffect, useMemo, useState } from 'react';
import {
  fetchAgentConfig,
  putAgentConfig,
  fetchProviderCatalog,
  type AgentConfig,
  type ProviderCatalogEntry,
} from '../api';

type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high';

const THINKING_LEVELS: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high'];
const CUSTOM = '__custom__';

export function BasicPanel() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalogEntry[]>([]);
  const [provider, setProvider] = useState('');
  const [providerMode, setProviderMode] = useState<'preset' | 'custom'>('preset');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState<Thinking | ''>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchAgentConfig(), fetchProviderCatalog()])
      .then(([c, cat]) => {
        setConfig(c);
        setCatalog(cat);
        const initialProvider = c.model?.provider ?? '';
        setProvider(initialProvider);
        // If the existing provider isn't in the catalog, drop the user
        // straight into custom mode so they can edit the free-text value.
        const isKnown = cat.some((e) => e.provider === initialProvider);
        setProviderMode(isKnown || !initialProvider ? 'preset' : 'custom');
        setModel(c.model?.model ?? '');
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

  const datalistId = 'basic-model-catalog';

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
              // so the user picks one from the new provider's list.
              if (value !== provider) setModel('');
            }}
          >
            <option value="">— pick a provider —</option>
            {catalog.map((e) => (
              <option key={e.provider} value={e.provider}>
                {e.provider} ({e.models.length})
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
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-model">Model</label>
        <input
          id="basic-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={modelsForProvider.length > 0 ? modelsForProvider[0]?.id : 'e.g. claude-sonnet-4-6'}
          autoComplete="off"
          list={modelsForProvider.length > 0 ? datalistId : undefined}
        />
        {modelsForProvider.length > 0 && (
          <datalist id={datalistId}>
            {modelsForProvider.map((m) => (
              <option key={m.id} value={m.id} />
            ))}
          </datalist>
        )}
        {modelsForProvider.length > 0 && (
          <p className="basic-panel__hint" style={{ marginTop: 4 }}>
            {modelsForProvider.length} known models for {provider}. You can also enter a custom id.
          </p>
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
