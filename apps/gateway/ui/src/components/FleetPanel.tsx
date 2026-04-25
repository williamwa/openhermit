import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

interface FleetAgent {
  agentId: string;
  name?: string;
  status: 'running' | 'stopped';
  sessions24h: number;
  errors24h: number;
  lastActivity?: string;
  channels: string[];
  skillsCount: number;
  mcpCount: number;
}

interface SkillInfo {
  id: string;
  name?: string;
}

const REFRESH_MS = 10_000;

const formatRelative = (iso?: string): string => {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

export function FleetPanel() {
  const [fleet, setFleet] = useState<FleetAgent[]>([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<FleetAgent[]>('/api/admin/agents/fleet');
      setFleet(data);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (bulkOpen) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [bulkOpen]);

  const allSelected = fleet.length > 0 && selected.size === fleet.length;
  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(fleet.map((a) => a.agentId)));
  };
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const totals = useMemo(() => ({
    running: fleet.filter((a) => a.status === 'running').length,
    sessions: fleet.reduce((acc, a) => acc + a.sessions24h, 0),
    errors: fleet.reduce((acc, a) => acc + a.errors24h, 0),
  }), [fleet]);

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>
          Fleet
          <span className="fleet__sub">
            &nbsp;· {totals.running}/{fleet.length} running · {totals.sessions} sessions/24h · {totals.errors} errors/24h
          </span>
        </h2>
        <div className="panel__header-actions">
          {selected.size > 0 && (
            <>
              <span className="fleet__selection">{selected.size} selected</span>
              <button className="btn btn--primary btn--sm" onClick={() => setBulkOpen(true)}>
                Bulk skill action…
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="agent-list__empty">{error}</p>}

      {!error && fleet.length === 0 && (
        <p className="agent-list__empty">No agents yet.</p>
      )}

      {fleet.length > 0 && (
        <table className="fleet-table">
          <thead>
            <tr>
              <th className="fleet-table__check">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th>Agent</th>
              <th>Status</th>
              <th>Last activity</th>
              <th className="fleet-table__num">Sessions (24h)</th>
              <th className="fleet-table__num">Errors (24h)</th>
              <th>Channels</th>
              <th className="fleet-table__num">Skills</th>
              <th className="fleet-table__num">MCP</th>
            </tr>
          </thead>
          <tbody>
            {fleet.map((a) => (
              <tr key={a.agentId} className={selected.has(a.agentId) ? 'fleet-row--selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(a.agentId)}
                    onChange={() => toggleOne(a.agentId)}
                    aria-label={`Select ${a.agentId}`}
                  />
                </td>
                <td>
                  <div className="fleet-cell-agent">
                    <span className="fleet-cell-agent__id">{a.agentId}</span>
                    {a.name && <span className="fleet-cell-agent__name">{a.name}</span>}
                  </div>
                </td>
                <td>
                  <span className={`badge badge--${a.status}`}>{a.status}</span>
                </td>
                <td className="fleet-cell-relative">{formatRelative(a.lastActivity)}</td>
                <td className="fleet-table__num">{a.sessions24h}</td>
                <td className={`fleet-table__num${a.errors24h > 0 ? ' fleet-cell-error' : ''}`}>
                  {a.errors24h}
                </td>
                <td>
                  {a.channels.length === 0 ? (
                    <span className="fleet-cell-muted">—</span>
                  ) : (
                    <div className="fleet-chips">
                      {a.channels.map((c) => (
                        <span className="fleet-chip" key={c}>{c}</span>
                      ))}
                    </div>
                  )}
                </td>
                <td className="fleet-table__num">{a.skillsCount}</td>
                <td className="fleet-table__num">{a.mcpCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <dialog ref={dialogRef} className="dialog">
        <BulkSkillDialog
          selected={selected}
          totalAgents={fleet.length}
          onClose={() => setBulkOpen(false)}
          onDone={() => {
            setBulkOpen(false);
            void load();
          }}
        />
      </dialog>
    </div>
  );
}

function BulkSkillDialog({
  selected,
  totalAgents,
  onClose,
  onDone,
}: {
  selected: Set<string>;
  totalAgents: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillId, setSkillId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const allSelected = selected.size === totalAgents && totalAgents > 0;

  useEffect(() => {
    void api<SkillInfo[]>('/api/admin/skills').then(setSkills).catch((e) => setError((e as Error).message));
  }, []);

  const apply = async (action: 'enable' | 'disable') => {
    if (!skillId) return;
    setBusy(true);
    setError('');
    try {
      if (allSelected) {
        await api(`/api/admin/skills/${encodeURIComponent(skillId)}/${action}`, {
          method: 'POST',
          body: { agentId: '*' },
        });
      } else {
        for (const id of selected) {
          await api(`/api/admin/skills/${encodeURIComponent(skillId)}/${action}`, {
            method: 'POST',
            body: { agentId: id },
          });
        }
      }
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog__inner">
      <h3>Bulk skill action</h3>
      <p className="dialog__hint">
        {allSelected
          ? `Affects all ${totalAgents} agents (uses wildcard '*' assignment).`
          : `Affects ${selected.size} selected agent${selected.size === 1 ? '' : 's'}.`}
      </p>

      <label className="field">
        <span>Skill</span>
        <select value={skillId} onChange={(e) => setSkillId(e.target.value)} disabled={busy}>
          <option value="">— pick a skill —</option>
          {skills.map((s) => (
            <option key={s.id} value={s.id}>{s.name || s.id}</option>
          ))}
        </select>
      </label>

      {error && <p className="dialog__error">{error}</p>}

      <div className="dialog__actions">
        <button
          className="btn btn--primary btn--sm"
          onClick={() => void apply('enable')}
          disabled={!skillId || busy}
        >
          Enable
        </button>
        <button
          className="btn btn--sm"
          onClick={() => void apply('disable')}
          disabled={!skillId || busy}
        >
          Disable
        </button>
        <button className="btn btn--ghost btn--sm" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
