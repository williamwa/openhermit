import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export function SecretsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<Record<string, string>>(`/api/admin/agents/${encodeURIComponent(agentId)}/secrets`)
      .then((data) => setSecrets(data))
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, [agentId]);

  const updateValue = (key: string, value: string) => {
    setSecrets((prev) => ({ ...prev, [key]: value }));
  };

  const deleteKey = (key: string) => {
    setSecrets((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const addSecret = () => {
    const k = newKey.trim();
    if (!k) return;
    setSecrets((prev) => ({ ...prev, [k]: newValue }));
    setNewKey('');
    setNewValue('');
  };

  const save = async () => {
    setError('');
    // Auto-add any pending new secret
    const final = { ...secrets };
    const pendingKey = newKey.trim();
    if (pendingKey) {
      final[pendingKey] = newValue;
      setNewKey('');
      setNewValue('');
      setSecrets(final);
    }
    try {
      await api(`/api/admin/agents/${encodeURIComponent(agentId)}/secrets`, {
        method: 'PUT',
        body: final,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const keys = Object.keys(secrets).sort();

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Secrets: {agentId}</h3>

        {loading && <p className="secrets-empty">Loading...</p>}

        {!loading && keys.length === 0 && (
          <p className="secrets-empty">No secrets configured.</p>
        )}

        {keys.map((k) => (
          <div className="secret-row" key={k}>
            <span className="secret-row__key">{k}</span>
            <input
              className="secret-row__value"
              type="text"
              value={secrets[k]}
              onChange={(e) => updateValue(k, e.target.value)}
            />
            <button className="btn btn--sm btn--danger" onClick={() => deleteKey(k)}>
              Delete
            </button>
          </div>
        ))}

        <div className="secrets-add">
          <input
            className="field__input field__input--inline"
            placeholder="Key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            className="field__input field__input--inline"
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <button className="btn btn--sm" type="button" onClick={addSecret}>Add</button>
        </div>

        {error && <p className="config-error">{error}</p>}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
          <button className="btn btn--primary" type="button" onClick={save}>Save</button>
        </div>
      </div>
    </dialog>
  );
}
