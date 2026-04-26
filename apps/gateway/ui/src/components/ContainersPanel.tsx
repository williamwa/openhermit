import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface ContainerInfo {
  id: string;
  name: string;
  agentId: string;
  agentName?: string;
  type: string;
  image: string;
  status: 'running' | 'exited' | 'created' | 'removed' | 'unknown';
  statusText: string;
}

const REFRESH_MS = 10_000;

const statusBadge = (status: ContainerInfo['status']): string => {
  switch (status) {
    case 'running': return 'badge--running';
    case 'created': return 'badge--paused';
    case 'exited':
    case 'removed':
    case 'unknown':
    default:
      return 'badge--stopped';
  }
};

export function ContainersPanel() {
  const [containers, setContainers] = useState<ContainerInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api<ContainerInfo[]>('/api/admin/containers');
      setContainers(data);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const totals = {
    running: containers.filter((c) => c.status === 'running').length,
    total: containers.length,
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>
          Containers
          <span className="fleet__sub">
            &nbsp;· {totals.running}/{totals.total} running
          </span>
        </h2>
        <div className="panel__header-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {loading && containers.length === 0 && (
        <p className="agent-list__empty">Loading containers…</p>
      )}

      {error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && containers.length === 0 && (
        <p className="agent-list__empty">No openhermit containers found.</p>
      )}

      {containers.length > 0 && (
        <>
          <div className="fleet-table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Image</th>
                </tr>
              </thead>
              <tbody>
                {containers.map((c) => (
                  <tr key={c.id || c.name}>
                    <td>
                      <div className="fleet-cell-agent">
                        <span className="fleet-cell-agent__id">{c.name}</span>
                        <span className="fleet-cell-agent__name">{c.id.slice(0, 12)}</span>
                      </div>
                    </td>
                    <td>{c.type}</td>
                    <td>
                      <div className="fleet-cell-agent">
                        <span className="fleet-cell-agent__id">{c.agentId}</span>
                        {c.agentName && (
                          <span className="fleet-cell-agent__name">{c.agentName}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${statusBadge(c.status)}`}>{c.status}</span>
                      <div className="fleet-cell-relative" style={{ marginTop: 2 }}>{c.statusText}</div>
                    </td>
                    <td className="fleet-cell-relative" style={{ fontFamily: 'var(--mono)' }}>{c.image}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fleet-cards">
            {containers.map((c) => (
              <div key={c.id || c.name} className="fleet-card">
                <div className="fleet-card__top">
                  <div className="fleet-card__heading">
                    <span className="fleet-card__id">{c.name}</span>
                    <span className="fleet-card__name">{c.image}</span>
                  </div>
                  <span className={`badge ${statusBadge(c.status)}`}>{c.status}</span>
                </div>
                <dl className="fleet-card__stats">
                  <div>
                    <dt>Type</dt>
                    <dd>{c.type}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{c.agentId}</dd>
                  </div>
                  <div>
                    <dt>Detail</dt>
                    <dd style={{ fontSize: '0.75rem' }}>{c.statusText}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
