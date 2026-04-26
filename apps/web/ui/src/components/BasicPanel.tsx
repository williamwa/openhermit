import { useEffect, useState } from 'react';
import { fetchAgentConfig, putAgentConfig, type AgentConfig } from '../api';

type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high';

const THINKING_LEVELS: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high'];

export function BasicPanel() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [thinking, setThinking] = useState<Thinking | ''>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    fetchAgentConfig()
      .then((c) => {
        setConfig(c);
        setProvider(c.model?.provider ?? '');
        setModel(c.model?.model ?? '');
        setThinking((c.model?.thinking as Thinking) ?? '');
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

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
      // If user cleared the thinking dropdown, drop the field.
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
        <input
          id="basic-provider"
          type="text"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="e.g. anthropic, openai, openrouter"
          autoComplete="off"
        />
      </div>

      <div className="basic-panel__field">
        <label htmlFor="basic-model">Model</label>
        <input
          id="basic-model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="e.g. claude-sonnet-4-6, moonshotai/kimi-k2.6"
          autoComplete="off"
        />
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
