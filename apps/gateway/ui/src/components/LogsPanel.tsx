import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface LogEntry {
  timestamp: string;
  message: string;
}

export function LogsPanel() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const load = () => {
      api<LogEntry[]>('/api/admin/logs?lines=500')
        .then((data) => {
          setEntries(data);
          setError('');
        })
        .catch((err) => setError((err as Error).message));
    };
    load();
    if (!autoRefresh) return;
    const timer = setInterval(load, 3_000);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  useEffect(() => {
    if (preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [entries]);

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Logs</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          <span>Auto-refresh</span>
        </label>
      </div>
      {error && <p>{error}</p>}
      <pre className="log-view" ref={preRef}>
        {entries.map((e, i) => (
          <span key={i}>
            <span className="ts">{e.timestamp.slice(11, 23)}</span>{' '}
            {e.message}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  );
}
