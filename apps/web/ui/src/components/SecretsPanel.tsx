import { useEffect, useState } from 'react';
import { fetchAgentSecrets, setAgentSecret, deleteAgentSecret } from '../api';

interface RowState {
  /** Key. */
  key: string;
  /** Server-supplied masked preview (empty for newly-added keys). */
  masked: string;
  /** Pending plaintext value the user typed; '' = no edit, anything else = replace. */
  draft: string;
  /** Marked for deletion. */
  deleted: boolean;
  /** True if this row was added in the editor (not loaded from server). */
  isNew: boolean;
}

export function SecretsPanel() {
  const [rows, setRows] = useState<RowState[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const loadFromServer = async () => {
    const map = await fetchAgentSecrets();
    setRows(
      Object.keys(map).sort().map((k) => ({
        key: k,
        masked: map[k] ?? '',
        draft: '',
        deleted: false,
        isNew: false,
      })),
    );
  };

  useEffect(() => {
    loadFromServer()
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const dirty = rows.some((r) => r.draft !== '' || r.deleted || r.isNew);

  const updateRow = (key: string, patch: Partial<RowState>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addNew = () => {
    if (!newKey.trim()) return;
    if (rows.some((r) => r.key === newKey.trim())) {
      setError(`Secret "${newKey.trim()}" already exists`);
      return;
    }
    setRows((rs) => [...rs, {
      key: newKey.trim(),
      masked: '',
      draft: newValue,
      deleted: false,
      isNew: true,
    }]);
    setNewKey('');
    setNewValue('');
    setError('');
  };

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      for (const r of rows) {
        if (r.deleted && !r.isNew) {
          await deleteAgentSecret(r.key);
        } else if (r.draft !== '') {
          await setAgentSecret(r.key, r.draft);
        }
        // Skip rows the user didn't touch.
      }
      await loadFromServer();
      setSavedAt(new Date().toLocaleTimeString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    void loadFromServer();
    setError('');
  };

  if (loading) return <p className="manage__empty">Loading…</p>;
  if (error && rows.length === 0) return <p className="manage__empty">{error}</p>;

  return (
    <div className="secrets-panel">
      <div className="secrets-panel__intro">
        <p className="eyebrow">Secrets</p>
        <p className="secrets-panel__hint">
          Provider API keys, channel tokens, and other credentials. Existing
          values are never returned to the browser; the placeholder shows
          how the server has masked the current value. Type a new value to
          replace, or delete the row to remove the secret.
        </p>
      </div>

      <div className="secrets-panel__list">
        {rows.length === 0 ? (
          <p className="manage__empty">No secrets configured yet.</p>
        ) : (
          rows.map((r) => (
            <div className={`secrets-row${r.deleted ? ' secrets-row--deleted' : ''}`} key={r.key}>
              <span className="secrets-row__key">{r.key}</span>
              <input
                type="text"
                className="secrets-row__value"
                value={r.draft}
                onChange={(e) => updateRow(r.key, { draft: e.target.value })}
                placeholder={r.masked || (r.isNew ? 'new value' : 'unchanged')}
                disabled={r.deleted}
                autoComplete="off"
              />
              <div className="secrets-row__actions">
                {r.draft !== '' && !r.isNew && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => updateRow(r.key, { draft: '' })}
                  >
                    Cancel
                  </button>
                )}
                {r.deleted ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => updateRow(r.key, { deleted: false })}
                  >
                    Undo
                  </button>
                ) : r.isNew ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  >
                    Remove
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm secrets-row__delete"
                    onClick={() => updateRow(r.key, { deleted: true, draft: '' })}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
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
