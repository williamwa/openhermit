import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { SecretsDialog } from './SecretsDialog';
import { ConfigDialog } from './ConfigDialog';

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

interface EffectiveSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  source: 'system' | 'workspace';
}

interface McpServerInfo {
  id: string;
  name: string;
  description: string;
  url: string;
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
  const [showCreate, setShowCreate] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [secretsAgent, setSecretsAgent] = useState<string | null>(null);
  const [configAgent, setConfigAgent] = useState<string | null>(null);
  const [skillsAgent, setSkillsAgent] = useState<string | null>(null);
  const [mcpAgent, setMcpAgent] = useState<string | null>(null);
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

  // Click outside to close the action menu.
  useEffect(() => {
    if (!openMenu) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('.fleet-actions')) setOpenMenu(null);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [openMenu]);

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

  const handleAction = async (agentId: string, action: string) => {
    setOpenMenu(null);
    try {
      await api(`/agents/${encodeURIComponent(agentId)}/manage/${action}`, { method: 'POST' });
    } catch (err) {
      alert(`Failed to ${action} ${agentId}: ${(err as Error).message}`);
    }
    await load();
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
          Agents
          <span className="fleet__sub">
            &nbsp;· {totals.running}/{fleet.length} running · {totals.sessions} sessions/24h · {totals.errors} errors/24h
          </span>
        </h2>
        <div className="panel__header-actions">
          {selected.size > 0 && (
            <>
              <span className="fleet__selection">{selected.size} selected</span>
              <button className="btn btn--primary btn--sm" onClick={() => setBulkOpen(true)}>
                Bulk skill…
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => void load()}>
            Refresh
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
            Create Agent
          </button>
        </div>
      </div>

      {error && <p className="agent-list__empty">{error}</p>}

      {!error && fleet.length === 0 && (
        <p className="agent-list__empty">No agents yet. Create one to get started.</p>
      )}

      {fleet.length > 0 && (
        <div className="fleet-table-wrap">
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
              <th className="fleet-table__num">Sessions 24h</th>
              <th className="fleet-table__num">Errors 24h</th>
              <th>Channels</th>
              <th className="fleet-table__num">Skills</th>
              <th className="fleet-table__num">MCP</th>
              <th className="fleet-table__actions"></th>
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
                <td className="fleet-table__actions">
                  <div className="fleet-actions">
                    <button
                      className="btn btn--ghost btn--sm fleet-actions__trigger"
                      aria-label={`Manage ${a.agentId}`}
                      aria-expanded={openMenu === a.agentId}
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenu(openMenu === a.agentId ? null : a.agentId);
                      }}
                    >
                      ⋮
                    </button>
                    {openMenu === a.agentId && (
                      <div className="fleet-actions__menu" role="menu">
                        {a.status === 'stopped' ? (
                          <button role="menuitem" onClick={() => handleAction(a.agentId, 'start')}>Start</button>
                        ) : (
                          <>
                            <button role="menuitem" onClick={() => handleAction(a.agentId, 'restart')}>Restart</button>
                            <button role="menuitem" onClick={() => handleAction(a.agentId, 'stop')}>Stop</button>
                          </>
                        )}
                        <div className="fleet-actions__divider" />
                        <button role="menuitem" onClick={() => { setOpenMenu(null); setConfigAgent(a.agentId); }}>Config</button>
                        <button role="menuitem" onClick={() => { setOpenMenu(null); setSkillsAgent(a.agentId); }}>Skills</button>
                        <button role="menuitem" onClick={() => { setOpenMenu(null); setMcpAgent(a.agentId); }}>MCP</button>
                        <button role="menuitem" onClick={() => { setOpenMenu(null); setSecretsAgent(a.agentId); }}>Secrets</button>
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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

      {showCreate && <CreateAgentDialog onClose={() => setShowCreate(false)} onCreated={load} />}
      {secretsAgent && <SecretsDialog agentId={secretsAgent} onClose={() => setSecretsAgent(null)} />}
      {configAgent && <ConfigDialog agentId={configAgent} onClose={() => setConfigAgent(null)} />}
      {skillsAgent && <AgentSkillsDialog agentId={skillsAgent} onClose={() => setSkillsAgent(null)} />}
      {mcpAgent && <AgentMcpDialog agentId={mcpAgent} onClose={() => setMcpAgent(null)} />}
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

function CreateAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [agentId, setAgentId] = useState('');
  const [name, setName] = useState('');
  const [owner, setOwner] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId.trim()) return;
    try {
      await api('/agents', {
        method: 'POST',
        body: {
          agentId: agentId.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(owner.trim() ? { ownerUserId: owner.trim() } : {}),
        },
      });
      onClose();
      onCreated();
    } catch (err) {
      alert(`Failed to create agent: ${(err as Error).message}`);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog" onClose={onClose}>
      <form className="dialog__form" onSubmit={handleSubmit}>
        <h3>Create Agent</h3>
        <label className="field">
          <span className="field__label">Agent ID</span>
          <input className="field__input" required value={agentId} onChange={(e) => setAgentId(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Name (optional)</span>
          <input className="field__input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Owner User ID (optional)</span>
          <input className="field__input" placeholder="e.g. usr-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
        </label>
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" type="submit">Create</button>
        </div>
      </form>
    </dialog>
  );
}

function AgentSkillsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [skills, setSkills] = useState<EffectiveSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<EffectiveSkill[]>(`/api/agents/${encodeURIComponent(agentId)}/skills`)
      .then((data) => { setSkills(data); setLoading(false); })
      .catch((err) => { setError((err as Error).message); setLoading(false); });
  }, [agentId]);

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Active Skills — {agentId}</h3>

        {loading && <p className="secrets-empty">Loading…</p>}
        {error && <p className="config-error">{error}</p>}

        {!loading && !error && skills.length === 0 && (
          <p className="secrets-empty">No skills active for this agent.</p>
        )}

        {skills.map((s) => (
          <div className="skill-card" key={s.id}>
            <div className="skill-card__info">
              <span className="skill-card__name">{s.name}</span>
              <span className="skill-card__id">{s.id}</span>
              <span className={`badge badge--${s.source === 'system' ? 'running' : 'stopped'}`}>
                {s.source}
              </span>
              <div className="skill-card__desc">{s.description}</div>
            </div>
          </div>
        ))}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}

function AgentMcpDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api<McpServerInfo[]>(`/api/agents/${encodeURIComponent(agentId)}/mcp-servers`)
      .then((data) => { setServers(data); setLoading(false); })
      .catch((err) => { setError((err as Error).message); setLoading(false); });
  }, [agentId]);

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>MCP Servers — {agentId}</h3>

        {loading && <p className="secrets-empty">Loading…</p>}
        {error && <p className="config-error">{error}</p>}

        {!loading && !error && servers.length === 0 && (
          <p className="secrets-empty">No MCP servers enabled for this agent.</p>
        )}

        {servers.map((s) => (
          <div className="skill-card" key={s.id}>
            <div className="skill-card__info">
              <span className="skill-card__name">{s.name}</span>
              <span className="skill-card__id">{s.id}</span>
              <div className="skill-card__desc">{s.description}</div>
              <div className="skill-card__path">{s.url}</div>
            </div>
          </div>
        ))}

        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </dialog>
  );
}
