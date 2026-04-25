import { useCallback, useEffect, useState } from 'react';
import {
  fetchChannels,
  enableChannel,
  disableChannel,
  configureChannel,
  removeChannel,
  type ChannelInfo,
} from '../api';

export function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setChannels(await fetchChannels());
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleToggle = async (ch: ChannelInfo) => {
    try {
      if (ch.enabled) {
        await disableChannel(ch.id);
      } else {
        await enableChannel(ch.id);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRemove = async (ch: ChannelInfo) => {
    if (!confirm(`Remove ${ch.label} channel configuration?`)) return;
    try {
      await removeChannel(ch.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const openConfigure = (ch: ChannelInfo) => {
    setConfiguring(ch.id);
    setSecretValues({});
    setError('');
  };

  const handleSave = async () => {
    if (!configuring) return;
    const ch = channels.find((c) => c.id === configuring);
    if (!ch) return;

    const missing = ch.secretKeys.filter((sk) => !secretValues[sk.key]?.trim());
    if (missing.length > 0 && !ch.configured) {
      setError(`Please fill in: ${missing.map((m) => m.label).join(', ')}`);
      return;
    }

    setSaving(true);
    try {
      const secrets: Record<string, string> = {};
      for (const sk of ch.secretKeys) {
        const val = secretValues[sk.key]?.trim();
        if (val) secrets[sk.key] = val;
      }
      await configureChannel(configuring, secrets);
      setConfiguring(null);
      setSecretValues({});
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="manage__empty">Loading...</p>;

  const configured = channels.filter((c) => c.configured);
  const available = channels.filter((c) => !c.configured);
  const configuringChannel = channels.find((c) => c.id === configuring);

  return (
    <div className="manage__list">
      {error && <p className="manage__error">{error}</p>}

      {configured.length === 0 && !configuring && (
        <p className="manage__empty">No channels configured.</p>
      )}

      {configured.map((ch) => (
        <div className="manage__card" key={ch.id}>
          <div className="manage__card-info">
            <div className="manage__card-header">
              <span className="manage__card-name">{ch.label}</span>
              {ch.status === 'error' ? (
                <span className="manage__card-badge manage__card-badge--err" title={ch.error}>Error</span>
              ) : (
                <span className={`manage__card-badge ${ch.enabled ? 'manage__card-badge--on' : 'manage__card-badge--off'}`}>
                  {ch.status === 'connected' ? 'Connected' : ch.enabled ? 'Enabled' : 'Disabled'}
                </span>
              )}
              {ch.configured && !ch.secretsSet && (
                <span className="manage__card-badge manage__card-badge--warn">Secrets missing</span>
              )}
            </div>
            {ch.error && (
              <div className="manage__card-error">{ch.error}</div>
            )}
          </div>
          <div className="manage__card-actions">
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => openConfigure(ch)}
            >
              Configure
            </button>
            <button
              className={`btn btn--sm ${ch.enabled ? 'btn--ghost' : 'btn--primary'}`}
              onClick={() => void handleToggle(ch)}
            >
              {ch.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              className="btn btn--sm btn--danger"
              onClick={() => void handleRemove(ch)}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {configuringChannel && (
        <div className="manage__dialog">
          <div className="manage__dialog-header">
            <h3>Configure {configuringChannel.label}</h3>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfiguring(null)}>Cancel</button>
          </div>
          <div className="manage__dialog-body">
            {configuringChannel.secretKeys.map((sk) => (
              <div className="manage__field" key={sk.key}>
                <label className="manage__field-label">{sk.label}</label>
                <input
                  className="manage__field-input"
                  type="password"
                  placeholder={sk.placeholder}
                  value={secretValues[sk.key] ?? ''}
                  onChange={(e) => setSecretValues((prev) => ({ ...prev, [sk.key]: e.target.value }))}
                />
                {configuringChannel.configured && (
                  <span className="manage__field-hint">Leave blank to keep existing value</span>
                )}
              </div>
            ))}
          </div>
          <div className="manage__dialog-footer">
            <button className="btn btn--primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      )}

      {available.length > 0 && !configuring && (
        <div className="manage__section">
          <h3 className="manage__section-title">Add Channel</h3>
          <div className="manage__add-list">
            {available.map((ch) => (
              <button
                key={ch.id}
                className="btn btn--sm btn--outline"
                onClick={() => openConfigure(ch)}
              >
                + {ch.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
