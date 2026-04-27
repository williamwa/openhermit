import { useEffect, useState, type FormEvent } from 'react';
import {
  getDisplayName,
  getUserId,
  joinAgent,
  listMyAgents,
  type AgentMembership,
  type Connection,
} from '../api';

interface Props {
  gatewayUrl: string;
  onPick: (conn: Connection) => Promise<void>;
  onSignOut: () => void;
}

/**
 * Step 2 — agent selection.
 *
 * Shows the user's current memberships (click to enter chat) and a form
 * to join a new agent. For protected agents the access token field is
 * required; otherwise it's left blank.
 */
export function PickAgentScreen({ gatewayUrl, onPick, onSignOut }: Props) {
  const [memberships, setMemberships] = useState<AgentMembership[] | null>(null);
  const [error, setError] = useState('');
  const [joinAgentId, setJoinAgentId] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setMemberships(await listMyAgents());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const enter = async (m: AgentMembership): Promise<void> => {
    setError('');
    setBusy(true);
    try {
      await onPick({ gatewayUrl, agentId: m.agentId, role: m.role });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleJoin = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const id = joinAgentId.trim();
    if (!id) return;
    setError('');
    setBusy(true);
    try {
      const membership = await joinAgent(id, joinToken.trim() || undefined);
      await onPick({
        gatewayUrl,
        agentId: id,
        role: membership.role,
        ...(joinToken.trim() ? { token: joinToken.trim() } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card card--form" style={{ maxWidth: 520 }}>
        <p className="eyebrow">OpenHermit</p>
        <h1>Pick an agent</h1>
        <p className="hint">
          Signed in as <strong>{getDisplayName() || 'Unknown'}</strong>
          {getUserId() && <span className="hint__uid"> · {getUserId()}</span>}
          <span style={{ color: 'var(--muted)' }}> at </span>
          <code style={{ fontSize: 12 }}>{gatewayUrl}</code>
        </p>

        {error && <p className="form-error">{error}</p>}

        <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 16, marginBottom: 8 }}>
          Your agents
        </h3>
        {memberships === null && <p className="hint">Loading…</p>}
        {memberships !== null && memberships.length === 0 && (
          <p className="hint">No agent memberships yet — join one below.</p>
        )}
        {memberships !== null && memberships.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
            {memberships.map((m) => (
              <button
                key={m.agentId}
                type="button"
                className="btn btn--ghost"
                disabled={busy}
                onClick={() => void enter(m)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 12px', textAlign: 'left',
                }}
              >
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                  <strong>{m.name ?? m.agentId}</strong>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{m.agentId} · {m.role}</span>
                </span>
                <span style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: m.status === 'running' ? 'var(--success-bg, #dcfce7)' : 'var(--surface, #f4f4f5)',
                  color: m.status === 'running' ? 'var(--success, #166534)' : 'var(--muted)',
                }}>
                  {m.status}
                </span>
              </button>
            ))}
          </div>
        )}

        <h3 style={{ fontSize: 13, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 24, marginBottom: 8 }}>
          Join another agent
        </h3>
        <form onSubmit={handleJoin}>
          <label className="field">
            <span className="field__label">Agent ID</span>
            <input
              className="field__input"
              type="text"
              placeholder="e.g. one"
              required
              value={joinAgentId}
              onChange={(e) => setJoinAgentId(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field__label">Access Token</span>
            <input
              className="field__input"
              type="password"
              placeholder="Only if the agent is protected"
              value={joinToken}
              onChange={(e) => setJoinToken(e.target.value)}
            />
          </label>
          <button
            className="btn btn--primary btn--full"
            type="submit"
            disabled={!joinAgentId.trim() || busy}
          >
            {busy ? 'Joining...' : 'Join'}
          </button>
        </form>

        <button
          className="btn btn--ghost btn--sm"
          type="button"
          onClick={onSignOut}
          style={{ marginTop: 16 }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
