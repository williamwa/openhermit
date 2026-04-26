import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api';

interface UserSummary {
  userId: string;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  identityCount: number;
}

interface UserIdentity {
  userId: string;
  channel: string;
  channelUserId: string;
  createdAt: string;
}

const REFRESH_MS = 15_000;

const formatDate = (iso: string): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
};

export function UsersPanel() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [identities, setIdentities] = useState<Record<string, UserIdentity[]>>({});
  const [identitiesLoading, setIdentitiesLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const data = await api<UserSummary[]>('/api/admin/users');
      setUsers(data);
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

  const toggleExpand = async (userId: string) => {
    if (expanded === userId) {
      setExpanded(null);
      return;
    }
    setExpanded(userId);
    if (!identities[userId]) {
      setIdentitiesLoading((prev) => ({ ...prev, [userId]: true }));
      try {
        const data = await api<UserIdentity[]>(
          `/api/admin/users/${encodeURIComponent(userId)}/identities`,
        );
        setIdentities((prev) => ({ ...prev, [userId]: data }));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setIdentitiesLoading((prev) => ({ ...prev, [userId]: false }));
      }
    }
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>
          Users
          <span className="fleet__sub">&nbsp;· {users.length} total</span>
        </h2>
        <div className="panel__header-actions">
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {loading && users.length === 0 && (
        <p className="agent-list__empty">Loading users…</p>
      )}

      {error && <p className="agent-list__empty">{error}</p>}

      {!loading && !error && users.length === 0 && (
        <p className="agent-list__empty">No users yet.</p>
      )}

      {users.length > 0 && (
        <>
          <div className="fleet-table-wrap">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th className="fleet-table__num">Identities</th>
                  <th>Created</th>
                  <th>Updated</th>
                  <th className="fleet-table__actions"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <Fragment key={u.userId}>
                    <tr>
                      <td>
                        <div className="fleet-cell-agent">
                          <span className="fleet-cell-agent__id">
                            {u.name || u.userId}
                          </span>
                          {u.name && (
                            <span className="fleet-cell-agent__name">{u.userId}</span>
                          )}
                        </div>
                      </td>
                      <td className="fleet-table__num">{u.identityCount}</td>
                      <td className="fleet-cell-relative">{formatDate(u.createdAt)}</td>
                      <td className="fleet-cell-relative">{formatDate(u.updatedAt)}</td>
                      <td className="fleet-table__actions">
                        <button
                          className="btn btn--ghost btn--sm"
                          onClick={() => void toggleExpand(u.userId)}
                          aria-expanded={expanded === u.userId}
                        >
                          {expanded === u.userId ? 'Hide' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {expanded === u.userId && (
                      <tr>
                        <td colSpan={5} className="users-identities">
                          <IdentitiesView
                            loading={identitiesLoading[u.userId] ?? false}
                            list={identities[u.userId] ?? []}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fleet-cards">
            {users.map((u) => (
              <div key={u.userId} className="fleet-card">
                <div className="fleet-card__top">
                  <div className="fleet-card__heading">
                    <span className="fleet-card__id">{u.name || u.userId}</span>
                    {u.name && <span className="fleet-card__name">{u.userId}</span>}
                  </div>
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => void toggleExpand(u.userId)}
                    aria-expanded={expanded === u.userId}
                  >
                    {expanded === u.userId ? 'Hide' : 'View'}
                  </button>
                </div>
                <dl className="fleet-card__stats">
                  <div>
                    <dt>Identities</dt>
                    <dd>{u.identityCount}</dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd style={{ fontSize: '0.75rem' }}>{formatDate(u.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd style={{ fontSize: '0.75rem' }}>{formatDate(u.updatedAt)}</dd>
                  </div>
                </dl>
                {expanded === u.userId && (
                  <div className="users-identities">
                    <IdentitiesView
                      loading={identitiesLoading[u.userId] ?? false}
                      list={identities[u.userId] ?? []}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IdentitiesView({ loading, list }: { loading: boolean; list: UserIdentity[] }) {
  if (loading) return <p className="users-identities__empty">Loading identities…</p>;
  if (list.length === 0) return <p className="users-identities__empty">No identities linked.</p>;
  return (
    <table className="users-identities__table">
      <thead>
        <tr>
          <th>Channel</th>
          <th>Channel User ID</th>
          <th>Linked</th>
        </tr>
      </thead>
      <tbody>
        {list.map((i) => (
          <tr key={`${i.channel}:${i.channelUserId}`}>
            <td><span className="fleet-chip">{i.channel}</span></td>
            <td style={{ fontFamily: 'var(--mono)', fontSize: '0.78rem' }}>{i.channelUserId}</td>
            <td className="fleet-cell-relative">{formatDate(i.createdAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
