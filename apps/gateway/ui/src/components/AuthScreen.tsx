import { FormEvent, useState } from 'react';

export function AuthScreen({ onSignIn }: { onSignIn: (token: string) => Promise<void> }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await onSignIn(token.trim());
    } catch (err) {
      setError(`Authentication failed: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-form" onSubmit={handleSubmit}>
        <p className="eyebrow">OpenHermit</p>
        <h1>Gateway Admin</h1>
        <label className="field">
          <span className="field__label">Admin Token</span>
          <input
            className="field__input"
            type="password"
            placeholder="Enter admin token"
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {error && <p className="auth-form__error">{error}</p>}
        <button className="btn btn--primary" type="submit" disabled={loading}>
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
