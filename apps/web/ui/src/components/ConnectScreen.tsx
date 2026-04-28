import { useState, type FormEvent } from 'react';
import { getDisplayName, getUserId, type Connection } from '../api';

interface Props {
  defaultGatewayUrl: string;
  defaultAgentId: string;
  defaultToken: string;
  error: string;
  onConnect: (conn: Connection) => Promise<void>;
}

export function ConnectScreen({ defaultGatewayUrl, defaultAgentId, defaultToken, error, onConnect }: Props) {
  const [gatewayUrl, setGatewayUrl] = useState(defaultGatewayUrl);
  const [agentId, setAgentId] = useState(defaultAgentId);
  const [token, setToken] = useState(defaultToken);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      await onConnect({
        gatewayUrl: gatewayUrl.trim().replace(/\/+$/, ''),
        agentId: agentId.trim(),
        token: token.trim() || undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card card--form" onSubmit={handleSubmit}>
        <p className="eyebrow">OpenHermit</p>
        <h1>Connect to Agent</h1>
        <p className="hint">
          <span>
            Signed in as <strong>{getDisplayName() || 'Unknown'}</strong>
            {getUserId() && <span className="hint__uid"> · {getUserId()}</span>}
          </span>
          <br />
          <span style={{ color: 'var(--muted)' }}>at </span>
          <code style={{ fontSize: 12 }}>{typeof window !== 'undefined' ? window.location.origin : ''}</code>
        </p>

        <label className="field">
          <span className="field__label">Gateway URL</span>
          <input
            className="field__input"
            type="url"
            placeholder="http://localhost:4000"
            required
            value={gatewayUrl}
            onChange={e => setGatewayUrl(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Agent ID</span>
          <input
            className="field__input"
            type="text"
            placeholder="one"
            required
            value={agentId}
            onChange={e => setAgentId(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Agent Access Token</span>
          <input
            className="field__input"
            type="password"
            placeholder="Only for protected agents"
            value={token}
            onChange={e => setToken(e.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="btn btn--primary btn--full" type="submit" disabled={loading}>
          {loading ? 'Connecting...' : 'Connect'}
        </button>
      </form>
    </div>
  );
}
