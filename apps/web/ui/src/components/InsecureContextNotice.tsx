/**
 * Rendered in place of the main app when the page is not loaded over a
 * secure context (HTTPS or localhost). Web Crypto is unavailable here, so
 * device-key auth would crash with "Cannot read properties of undefined
 * (reading 'generateKey')". We surface that as a clear message instead.
 */
export function InsecureContextNotice() {
  const url = typeof window !== 'undefined' ? window.location.href : '';
  return (
    <div style={styles.wrap}>
      <div style={styles.card}>
        <h1 style={styles.h1}>HTTPS required</h1>
        <p style={styles.p}>
          OpenHermit signs every request with a per-device ECDSA key generated
          by your browser. The key API (<code>window.crypto.subtle</code>) is
          only available over a <strong>secure context</strong> — that means
          HTTPS, <code>http://localhost</code>, or <code>http://127.0.0.1</code>.
        </p>
        <p style={styles.p}>You're currently on:</p>
        <pre style={styles.code}>{url}</pre>
        <p style={styles.p}>To get a working URL:</p>
        <ul style={styles.list}>
          <li>Use <strong>Tailscale Serve</strong> (<code>tailscale serve --bg https://*</code>) to front the web port with HTTPS over your tailnet.</li>
          <li>Put <strong>Caddy</strong> or <strong>nginx</strong> in front and let it auto-issue Let's Encrypt certs for your domain.</li>
          <li>Use a tunnel like <strong>cloudflared</strong> (<code>cloudflared tunnel --url http://localhost:4310</code>) — gives you HTTPS without opening ports.</li>
          <li>Or, if you only need local access, open <code>http://127.0.0.1:4310</code> on the host machine itself.</li>
        </ul>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2rem',
    background: '#fafafa',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: '#222',
  },
  card: {
    maxWidth: 620,
    background: '#fff',
    border: '1px solid #e5e5e5',
    borderRadius: 8,
    padding: '2rem 2.25rem',
    boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
  },
  h1: { margin: '0 0 1rem', fontSize: 22, fontWeight: 600 },
  p: { margin: '0.6rem 0', lineHeight: 1.55 },
  code: {
    background: '#f4f4f5',
    border: '1px solid #e5e5e5',
    borderRadius: 4,
    padding: '0.6rem 0.8rem',
    fontSize: 13,
    overflowX: 'auto',
    margin: '0.4rem 0 0.8rem',
  },
  list: { margin: '0.6rem 0 0', paddingLeft: '1.4rem', lineHeight: 1.6 },
};
