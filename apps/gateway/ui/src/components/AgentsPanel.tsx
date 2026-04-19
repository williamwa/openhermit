import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { SecretsDialog } from './SecretsDialog';
import { ConfigDialog } from './ConfigDialog';

interface AgentInfo {
  agentId: string;
  name?: string;
  status: 'running' | 'stopped';
  configDir: string;
}

export function AgentsPanel() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [secretsAgent, setSecretsAgent] = useState<string | null>(null);
  const [configAgent, setConfigAgent] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await api<AgentInfo[]>('/agents'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleAction = async (agentId: string, action: string) => {
    try {
      await api(`/agents/${encodeURIComponent(agentId)}/manage/${action}`, { method: 'POST' });
    } catch (err) {
      alert(`Failed to ${action} ${agentId}: ${(err as Error).message}`);
    }
    await load();
  };

  return (
    <div className="panel">
      <div className="panel__header">
        <h2>Agents</h2>
        <button className="btn btn--primary btn--sm" onClick={() => setShowCreate(true)}>
          Create Agent
        </button>
      </div>

      {error && <p className="agent-list__empty">{error}</p>}

      {!error && agents.length === 0 && (
        <p className="agent-list__empty">No agents yet. Create one to get started.</p>
      )}

      <div className="agent-list">
        {agents.map((a) => (
          <div className="agent-card" key={a.agentId}>
            <div className="agent-card__info">
              <span className="agent-card__id">{a.agentId}</span>
              {a.name && <span className="agent-card__name">{a.name}</span>}
              <span className={`badge badge--${a.status}`}>{a.status}</span>
              <div className="agent-card__dirs">{a.configDir}</div>
            </div>
            <div className="agent-card__actions">
              {a.status === 'stopped' ? (
                <button className="btn btn--sm" onClick={() => handleAction(a.agentId, 'start')}>
                  Start
                </button>
              ) : (
                <>
                  <button className="btn btn--sm" onClick={() => handleAction(a.agentId, 'stop')}>
                    Stop
                  </button>
                  <button className="btn btn--sm" onClick={() => handleAction(a.agentId, 'restart')}>
                    Restart
                  </button>
                  <button className="btn btn--sm" onClick={() => setConfigAgent(a.agentId)}>
                    Config
                  </button>
                  <button className="btn btn--sm" onClick={() => setSecretsAgent(a.agentId)}>
                    Secrets
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {showCreate && <CreateAgentDialog onClose={() => setShowCreate(false)} onCreated={load} />}
      {secretsAgent && <SecretsDialog agentId={secretsAgent} onClose={() => setSecretsAgent(null)} />}
      {configAgent && <ConfigDialog agentId={configAgent} onClose={() => setConfigAgent(null)} />}
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
