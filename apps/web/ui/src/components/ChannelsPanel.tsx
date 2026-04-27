import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchChannels,
  patchChannel,
  removeChannel,
  createExternalChannel,
  type ChannelInfo,
  type CreatedChannel,
} from '../api';

/**
 * Unified channel management — covers both built-in adapters
 * (telegram/discord/slack, in-process bridges) and owner-issued external
 * tokens (third-party adapters connecting from outside the gateway).
 *
 * Both kinds live in the agent_channels table; the server returns them
 * in one list. Built-in rows are auto-seeded on agent creation and only
 * support enable/disable/config-edit. External rows are created here
 * (with a token issued by the server) and can be revoked.
 */
export function ChannelsPanel() {
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editConfig, setEditConfig] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [saving, setSaving] = useState(false);

  // Create-external flow
  const [creating, setCreating] = useState(false);
  const [newNamespace, setNewNamespace] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [createdToken, setCreatedToken] = useState<CreatedChannel | null>(null);

  const editDialogRef = useRef<HTMLDialogElement>(null);
  const createDialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (editing) editDialogRef.current?.showModal();
    else editDialogRef.current?.close();
  }, [editing]);

  useEffect(() => {
    if (creating) createDialogRef.current?.showModal();
    else createDialogRef.current?.close();
  }, [creating]);

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
      await patchChannel(ch.id, { enabled: !ch.enabled });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRemove = async (ch: ChannelInfo) => {
    const what = ch.kind === 'builtin'
      ? `Reset ${ch.channelType} channel? (it will be re-created disabled on next gateway boot)`
      : `Revoke external channel "${ch.label ?? ch.namespace}"? Its token will stop working immediately.`;
    if (!confirm(what)) return;
    try {
      await removeChannel(ch.id);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startEdit = (ch: ChannelInfo) => {
    setEditing(ch.id);
    setEditConfig(JSON.stringify(ch.config, null, 2));
    setEditLabel(ch.label ?? '');
    setError('');
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(editConfig || '{}') as Record<string, unknown>;
      if (typeof parsedConfig !== 'object' || parsedConfig === null) {
        throw new Error('Config must be a JSON object');
      }
    } catch (err) {
      setError(`Invalid JSON: ${(err as Error).message}`);
      return;
    }
    setSaving(true);
    try {
      await patchChannel(editing, {
        config: parsedConfig,
        label: editLabel.trim() === '' ? null : editLabel.trim(),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateExternal = async () => {
    const ns = newNamespace.trim();
    if (!ns) {
      setError('Namespace is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await createExternalChannel({
        namespace: ns,
        ...(newLabel.trim() ? { label: newLabel.trim() } : {}),
      });
      setCreatedToken(created);
      setNewNamespace('');
      setNewLabel('');
      setCreating(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <p className="manage__empty">Loading...</p>;

  const builtin = channels.filter((c) => c.kind === 'builtin');
  const external = channels.filter((c) => c.kind === 'external');
  const editingChannel = channels.find((c) => c.id === editing);

  return (
    <div className="manage__list">
      {error && <p className="manage__error">{error}</p>}

      {createdToken && (
        <div className="manage__card manage__card--accent">
          <div className="manage__card-info">
            <div className="manage__card-header">
              <span className="manage__card-name">Token issued for {createdToken.namespace}</span>
            </div>
            <p className="manage__card-help">
              Save this now — it won't be shown again.
            </p>
            <pre className="manage__token">{createdToken.token}</pre>
          </div>
          <div className="manage__card-actions">
            <button className="btn btn--sm btn--ghost" onClick={() => setCreatedToken(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <h3 className="manage__section-title">Built-in channels</h3>
      {builtin.length === 0 && (
        <p className="manage__empty">No built-in channels yet (will be seeded on next agent restart).</p>
      )}
      {builtin.map((ch) => (
        <ChannelCard
          key={ch.id}
          ch={ch}
          onToggle={() => void handleToggle(ch)}
          onEdit={() => startEdit(ch)}
          onRemove={() => void handleRemove(ch)}
        />
      ))}

      <h3 className="manage__section-title" style={{ marginTop: 24 }}>
        External channel tokens
      </h3>
      <p className="manage__hint">
        For channel adapters running outside the gateway (a Telegram bot deployed
        elsewhere, a custom bridge). Each token is namespace-scoped and has no
        admin privileges.
      </p>
      {external.length === 0 && (
        <p className="manage__empty">No external tokens issued.</p>
      )}
      {external.map((ch) => (
        <ChannelCard
          key={ch.id}
          ch={ch}
          onToggle={() => void handleToggle(ch)}
          onEdit={() => startEdit(ch)}
          onRemove={() => void handleRemove(ch)}
        />
      ))}

      <div className="manage__add-list">
        <button className="btn btn--sm btn--outline" onClick={() => setCreating(true)}>
          + Issue external channel token
        </button>
      </div>

      <dialog ref={createDialogRef} className="manage__dialog" onClose={() => setCreating(false)}>
        <div className="manage__dialog-header">
          <h3>New external channel</h3>
          <button className="btn btn--sm btn--ghost" onClick={() => setCreating(false)}>Cancel</button>
        </div>
        <div className="manage__dialog-body">
          <div className="manage__field">
            <label className="manage__field-label">Namespace</label>
            <input
              className="manage__field-input"
              placeholder="e.g. telegram-bot, custom-slack"
              value={newNamespace}
              onChange={(e) => setNewNamespace(e.target.value)}
            />
            <span className="manage__field-hint">
              The adapter will only be able to act in this namespace (sender.channel must match).
            </span>
          </div>
          <div className="manage__field">
            <label className="manage__field-label">Label (optional)</label>
            <input
              className="manage__field-input"
              placeholder="Human-readable name"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
        </div>
        <div className="manage__dialog-footer">
          <button className="btn btn--primary" onClick={() => void handleCreateExternal()} disabled={saving}>
            {saving ? 'Creating...' : 'Issue token'}
          </button>
        </div>
      </dialog>

      <dialog ref={editDialogRef} className="manage__dialog" onClose={() => setEditing(null)}>
        {editingChannel && (
          <>
            <div className="manage__dialog-header">
              <h3>Edit {editingChannel.label ?? editingChannel.channelType}</h3>
              <button className="btn btn--sm btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
            <div className="manage__dialog-body">
              <div className="manage__field">
                <label className="manage__field-label">Label</label>
                <input
                  className="manage__field-input"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                />
              </div>
              <div className="manage__field">
                <label className="manage__field-label">Config (JSON)</label>
                <textarea
                  className="manage__field-input"
                  rows={10}
                  spellCheck={false}
                  style={{ fontFamily: 'var(--mono)', fontSize: 12 }}
                  value={editConfig}
                  onChange={(e) => setEditConfig(e.target.value)}
                />
                {editingChannel.secretKeys && editingChannel.secretKeys.length > 0 && (
                  <span className="manage__field-hint">
                    Reference secrets with <code>{'${{NAME}}'}</code>. Expected:{' '}
                    {editingChannel.secretKeys.map((sk) => sk.key).join(', ')}.
                  </span>
                )}
              </div>
            </div>
            <div className="manage__dialog-footer">
              <button className="btn btn--primary" onClick={() => void handleSaveEdit()} disabled={saving}>
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

function ChannelCard({ ch, onToggle, onEdit, onRemove }: {
  ch: ChannelInfo;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const statusClass =
    ch.runtimeStatus === 'error' ? 'manage__card-badge--err'
    : ch.enabled ? 'manage__card-badge--on'
    : 'manage__card-badge--off';
  const statusText =
    ch.runtimeStatus === 'connected' ? 'Connected'
    : ch.runtimeStatus === 'error' ? 'Error'
    : ch.enabled ? 'Enabled' : 'Disabled';
  return (
    <div className="manage__card">
      <div className="manage__card-info">
        <div className="manage__card-header">
          <span className="manage__card-name">
            {ch.label ?? ch.channelType}
            {ch.kind === 'external' && (
              <span className="manage__card-meta"> · {ch.namespace}</span>
            )}
          </span>
          <span className={`manage__card-badge ${statusClass}`}>{statusText}</span>
          {ch.kind === 'builtin' && !ch.secretsSet && (
            <span className="manage__card-badge manage__card-badge--warn">Secrets missing</span>
          )}
        </div>
        <div className="manage__card-meta">
          token <code>{ch.tokenPrefix}…</code>
        </div>
        {ch.error && <div className="manage__card-error">{ch.error}</div>}
      </div>
      <div className="manage__card-actions">
        <button className="btn btn--sm btn--ghost" onClick={onEdit}>Edit</button>
        <button
          className={`btn btn--sm ${ch.enabled ? 'btn--ghost' : 'btn--primary'}`}
          onClick={onToggle}
        >
          {ch.enabled ? 'Disable' : 'Enable'}
        </button>
        <button className="btn btn--sm btn--danger" onClick={onRemove}>
          {ch.kind === 'external' ? 'Revoke' : 'Reset'}
        </button>
      </div>
    </div>
  );
}
