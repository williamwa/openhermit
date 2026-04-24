import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export function ConfigDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('Loading...');
  const [error, setError] = useState('');

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  useEffect(() => {
    api(`/api/agents/${encodeURIComponent(agentId)}/config`)
      .then((data) => setText(JSON.stringify(data, null, 2)))
      .catch((err) => {
        setText('');
        setError((err as Error).message);
      });
  }, [agentId]);

  const save = async () => {
    setError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Invalid JSON.');
      return;
    }
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/config`, {
        method: 'PUT',
        body: parsed,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <dialog ref={dialogRef} className="dialog dialog--wide" onClose={onClose}>
      <div className="dialog__form">
        <h3>Config: {agentId}</h3>
        <textarea
          className="config-editor"
          rows={20}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="config-error">{error}</p>}
        <div className="dialog__actions">
          <button className="btn btn--ghost" type="button" onClick={onClose}>Close</button>
          <button className="btn btn--primary" type="button" onClick={save}>Save</button>
        </div>
      </div>
    </dialog>
  );
}
