import { useState, useEffect, type FormEvent } from 'react';
import { getDeviceFingerprint, getDisplayName, setDisplayName, isNewDevice } from '../api';

interface Props {
  onComplete: () => void;
}

export function SetupScreen({ onComplete }: Props) {
  const [fingerprint, setFingerprint] = useState('');
  const [name, setName] = useState(getDisplayName() || '');
  const [isNew, setIsNew] = useState(true);
  const [loading, setLoading] = useState(true);
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
    if (!name.trim()) return;
    setError('');
    try {
      setDisplayName(name.trim());
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) return null;

  return (
    <div className="center-screen">
      <form className="card card--form" onSubmit={handleSubmit}>
        <p className="eyebrow">OpenHermit</p>
        <h1>{isNew ? 'Welcome' : 'Device Identity'}</h1>
        <p className="hint">
          {isNew
            ? 'A new device key has been generated for this browser. Set your display name to get started.'
            : 'Your device key is ready.'}
        </p>

        <div className="device-key-display">
          <span className="field__label">Device Key Fingerprint</span>
          <code className="device-key-value">{shortFp}</code>
        </div>

        <label className="field">
          <span className="field__label">Display Name</span>
          <input
            className="field__input"
            type="text"
            placeholder="Your name"
            required
            autoFocus={isNew}
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="btn btn--primary btn--full" type="submit" disabled={!name.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
