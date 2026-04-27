import { useState, useEffect, type FormEvent } from 'react';
import {
  exchangeToken,
  getDeviceFingerprint,
  getDisplayName,
  isNewDevice,
  loadGatewayUrl,
  saveGatewayUrl,
  setDisplayName,
  setGateway,
} from '../api';

interface Props {
  onComplete: () => void;
}

/**
 * Step 1 — gateway connect.
 *
 * Generates a per-device ECDSA key (if not already), asks for the
 * gateway URL + display name, exchanges the device key for a
 * gateway-level JWT. The JWT has no agent in it; agent selection is
 * step 2 (PickAgentScreen).
 */
export function SetupScreen({ onComplete }: Props) {
  const [fingerprint, setFingerprint] = useState('');
  const [gatewayUrl, setGatewayUrl] = useState(loadGatewayUrl() ?? window.location.origin);
  const [name, setName] = useState(getDisplayName() ?? '');
  const [isNew, setIsNew] = useState(true);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const fp = await getDeviceFingerprint();
      setFingerprint(fp);
      setIsNew(isNewDevice());
      setLoading(false);
    })();
  }, []);

  const shortFp = fingerprint
    ? `${fingerprint.slice(0, 8)}...${fingerprint.slice(-8)}`
    : '';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const url = gatewayUrl.trim().replace(/\/+$/, '');
    const dn = name.trim();
    if (!url || !dn) return;
    setError('');
    setSubmitting(true);
    try {
      setDisplayName(dn);
      saveGatewayUrl(url);
      setGateway(url);
      await exchangeToken(dn);
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;

  return (
    <div className="center-screen">
      <form className="card card--form" onSubmit={handleSubmit}>
        <p className="eyebrow">OpenHermit</p>
        <h1>{isNew ? 'Welcome' : 'Connect to Gateway'}</h1>
        <p className="hint">
          {isNew
            ? 'A new device key has been generated for this browser. Tell us where the gateway is and what to call you.'
            : 'Sign in to your gateway with this device key.'}
        </p>

        <div className="device-key-display">
          <span className="field__label">Device Key Fingerprint</span>
          <code className="device-key-value">{shortFp}</code>
        </div>

        <label className="field">
          <span className="field__label">Gateway URL</span>
          <input
            className="field__input"
            type="url"
            placeholder="https://hermit.example.com"
            required
            value={gatewayUrl}
            onChange={(e) => setGatewayUrl(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field__label">Display Name</span>
          <input
            className="field__input"
            type="text"
            placeholder="Your name"
            required
            autoFocus={isNew}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button
          className="btn btn--primary btn--full"
          type="submit"
          disabled={!name.trim() || !gatewayUrl.trim() || submitting}
        >
          {submitting ? 'Connecting...' : 'Continue'}
        </button>
      </form>
    </div>
  );
}
