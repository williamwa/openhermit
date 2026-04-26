import { useEffect, useState } from 'react';
import { fetchAgentSecrets, putAgentSecrets } from '../api';

/** Mask a value: show first 4 + last 4 chars, middle as ****. Short values are fully masked. */
const maskValue = (value: string): string => {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}${'*'.repeat(Math.max(4, Math.min(8, value.length - 8)))}${value.slice(-4)}`;
};

interface DraftEntry {
  key: string;
  /** New plaintext value if user typed something; undefined means "unchanged". */
  next?: string;
  /** True if this row was added in the editor (not loaded from server). */
  isNew?: boolean;
  /** True if user marked it for deletion. */
  deleted?: boolean;
}

export function SecretsPanel() {
  const [original, setOriginal] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    fetchAgentSecrets()
      .then((s) => {
        setOriginal(s);
        setDrafts(Object.keys(s).sort().map((k) => ({ key: k })));
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const dirty = drafts.some((d) => d.next !== undefined || d.deleted || d.isNew);

  const updateDraft = (key: string, patch: Partial<DraftEntry>) => {
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  };

  const addNew = () => {
    if (!newKey.trim()) return;
    if (drafts.some((d) => d.key === newKey.trim())) {
      setError(`Secret "${newKey.trim()}" already exists`);
      return;
    }
    setDrafts((ds) => [...ds, { key: newKey.trim(), next: newValue, isNew: true }]);
    setNewKey('');
    setNewValue('');
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      // Build the next full secrets map: keep originals, apply edits / deletions / additions.
      const next: Record<string, string> = { ...original };
      for (const d of drafts) {
        if (d.deleted) {
          delete next[d.key];
          continue;
        }
        if (d.next !== undefined) {
          next[d.key] = d.next;
        }
      }
      await putAgentSecrets(next);
      setOriginal(next);
      setDrafts(Object.keys(next).sort().map((k) => ({ key: k })));
      setRevealed({});
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDrafts(Object.keys(original).sort().map((k) => ({ key: k })));
    setError('');
  };

  if (loading) return <p className="manage__empty">Loading…</p>;
  if (error && Object.keys(original).length === 0 && drafts.length === 0) {
    return <p className="manage__empty">{error}</p>;
  }

  return (
    <div className="secrets-panel">
      <div className="secrets-panel__intro">
        <p className="eyebrow">Secrets</p>
        <p className="secrets-panel__hint">
          Provider API keys, channel tokens, and other credentials. Stored
          server-side; only first / last few characters are shown here. Type
          a new value to replace; leave blank to keep the existing value.
        </p>
      </div>

      <div className="secrets-panel__list">
        {drafts.length === 0 ? (
          <p className="manage__empty">No secrets configured yet.</p>
        ) : (
          drafts.map((d) => {
            const existing = original[d.key];
            const display = d.deleted
              ? '(removed)'
              : d.next !== undefined
                ? d.next  // user is typing a new value
                : (revealed[d.key] && existing ? existing : maskValue(existing ?? ''));
            return (
              <div className={`secrets-row${d.deleted ? ' secrets-row--deleted' : ''}`} key={d.key}>
                <span className="secrets-row__key">{d.key}</span>
                <input
                  type={d.next !== undefined ? 'text' : 'password'}
                  className="secrets-row__value"
                  value={d.next ?? display}
                  onChange={(e) => updateDraft(d.key, { next: e.target.value })}
                  placeholder={existing ? maskValue(existing) : ''}
                  disabled={d.deleted}
                />
                <div className="secrets-row__actions">
                  {!d.deleted && existing && d.next === undefined && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setRevealed((r) => ({ ...r, [d.key]: !r[d.key] }))}
                    >
                      {revealed[d.key] ? 'Hide' : 'Reveal'}
                    </button>
                  )}
                  {d.next !== undefined && !d.isNew && (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => updateDraft(d.key, { next: undefined })}
                    >
                      Cancel
                    </button>
                  )}
                  {d.deleted ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => updateDraft(d.key, { deleted: false })}
                    >
                      Undo
                    </button>
                  ) : d.isNew ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setDrafts((ds) => ds.filter((x) => x.key !== d.key))}
                    >
                      Remove
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm secrets-row__delete"
                      onClick={() => updateDraft(d.key, { deleted: true, next: undefined })}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="secrets-panel__add">
        <input
          type="text"
          placeholder="Key (e.g. ANTHROPIC_API_KEY)"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
        />
        <input
          type="password"
          placeholder="Value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
        />
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!newKey.trim()}
          onClick={addNew}
        >
          Add
        </button>
      </div>

      {error && <p className="basic-panel__error">{error}</p>}

      <div className="basic-panel__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={!dirty || saving}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button type="button" className="btn btn--ghost" onClick={handleDiscard} disabled={saving}>
            Discard
          </button>
        )}
        {savedAt && !dirty && (
          <span className="basic-panel__saved">Saved at {savedAt}</span>
        )}
      </div>
    </div>
  );
}
