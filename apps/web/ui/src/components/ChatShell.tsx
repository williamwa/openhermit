import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, getJwt, getApiBase, type Connection, type SessionSummary, type HistoryMessage } from '../api';
import { SessionList } from './SessionList';
import { ChatMessages, type ChatItem } from './ChatMessages';
import { Composer } from './Composer';

const createSessionId = () =>
  `web:${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

interface Props {
  connection: Connection;
  onDisconnect: () => void;
}

export function ChatShell({ connection, onDisconnect }: Props) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState('Idle');
  const [sending, setSending] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const currentEventIdRef = useRef(0);
  const streamingTextRef = useRef('');

  const refreshSessions = useCallback(async () => {
    const response = await apiFetch('/sessions?limit=50');
    if (response.ok) {
      setSessions(await response.json());
    }
  }, []);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const connectToStream = useCallback(async (sessionId: string) => {
    closeEventSource();
    streamingTextRef.current = '';

    const token = await getJwt();
    const url = `${getApiBase()}/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token)}`;
    const source = new EventSource(url);
    eventSourceRef.current = source;
    setStatus('Streaming');

    const guard = (handler: (event: MessageEvent) => void) => (event: MessageEvent) => {
      const eventId = Number.parseInt(event.lastEventId || '0', 10);
      if (eventId !== 0 && eventId <= currentEventIdRef.current) return;
      currentEventIdRef.current = Math.max(currentEventIdRef.current, eventId || 0);
      handler(event);
    };

    source.addEventListener('tool_requested', guard((event) => {
      const p = JSON.parse(event.data);
      setItems(prev => [...prev, { type: 'tool', tool: p.tool, args: p.args, phase: 'requested' }]);
    }));

    source.addEventListener('tool_started', guard((event) => {
      const p = JSON.parse(event.data);
      setItems(prev => {
        const idx = prev.findLastIndex(i => i.type === 'tool' && i.tool === p.tool && i.phase === 'requested');
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], phase: 'running' } as ChatItem;
          return updated;
        }
        return [...prev, { type: 'tool', tool: p.tool, args: p.args, phase: 'running' }];
      });
    }));

    source.addEventListener('tool_result', guard((event) => {
      const p = JSON.parse(event.data);
      setItems(prev => {
        const idx = prev.findLastIndex(i => i.type === 'tool' && i.tool === p.tool && i.phase !== 'done');
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], phase: 'done', isError: p.isError, result: p.text || (p.details ? JSON.stringify(p.details, null, 2) : '') } as ChatItem;
          return updated;
        }
        return prev;
      });
    }));

    source.addEventListener('tool_approval_required', guard((event) => {
      const p = JSON.parse(event.data);
      setItems(prev => [...prev, { type: 'approval', toolName: p.toolName, toolCallId: p.toolCallId, args: p.args, resolved: false }]);
    }));

    source.addEventListener('text_delta', guard((event) => {
      const p = JSON.parse(event.data);
      streamingTextRef.current += p.text;
      const text = streamingTextRef.current;
      setItems(prev => {
        const last = prev[prev.length - 1];
        if (last?.type === 'assistant' && last.streaming) {
          const updated = [...prev];
          updated[updated.length - 1] = { type: 'assistant', text, streaming: true };
          return updated;
        }
        return [...prev, { type: 'assistant', text, streaming: true }];
      });
    }));

    source.addEventListener('text_final', guard((event) => {
      const p = JSON.parse(event.data);
      const finalText = p.text || streamingTextRef.current;
      streamingTextRef.current = '';
      setItems(prev => {
        const last = prev[prev.length - 1];
        if (last?.type === 'assistant') {
          const updated = [...prev];
          updated[updated.length - 1] = { type: 'assistant', text: finalText, streaming: false };
          return updated;
        }
        return [...prev, { type: 'assistant', text: finalText, streaming: false }];
      });
    }));

    source.addEventListener('error', guard((event) => {
      if ((event as MessageEvent).data) {
        const p = JSON.parse((event as MessageEvent).data);
        setItems(prev => [...prev, { type: 'event', text: p.message, isError: true }]);
      }
    }));

    source.addEventListener('agent_end', guard(async () => {
      streamingTextRef.current = '';
      setSending(false);
      setStatus('Idle');
      await refreshSessions();
    }));

    source.addEventListener('ready', () => setStatus('Connected'));
    source.onerror = () => setStatus('Reconnecting...');
  }, [closeEventSource, refreshSessions]);

  const selectSession = useCallback(async (sessionId: string) => {
    if (sessionId === currentSessionId) return;

    setCurrentSessionId(sessionId);
    currentEventIdRef.current = 0;
    setItems([]);

    await apiFetch('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, source: { kind: 'api', interactive: true, platform: 'web' }, metadata: {} }),
    });

    const session = sessions.find(s => s.sessionId === sessionId);
    currentEventIdRef.current = session?.lastEventId ?? 0;

    const historyResponse = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (historyResponse.ok) {
      const history: HistoryMessage[] = await historyResponse.json();
      const historyItems: ChatItem[] = history.map(entry => {
        if (entry.role === 'error') return { type: 'event', text: entry.content, isError: true };
        return { type: entry.role as 'user' | 'assistant', text: entry.content, streaming: false };
      });
      setItems(historyItems);
    }

    await connectToStream(sessionId);
  }, [currentSessionId, sessions, connectToStream]);

  const createNewSession = useCallback(async () => {
    if (currentSessionId) {
      await apiFetch(`/sessions/${encodeURIComponent(currentSessionId)}/checkpoint`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'new_session' }),
      }).catch(() => {});
    }

    const sessionId = createSessionId();
    await apiFetch('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, source: { kind: 'api', interactive: true, platform: 'web' }, metadata: {} }),
    });
    await refreshSessions();
    await selectSession(sessionId);
  }, [currentSessionId, refreshSessions, selectSession]);

  const sendMessage = useCallback(async (text: string) => {
    if (!currentSessionId || !text.trim()) return;
    setItems(prev => [...prev, { type: 'user', text, streaming: false }]);
    setSending(true);
    setStatus('Running');
    streamingTextRef.current = '';

    try {
      const response = await apiFetch(
        `/sessions/${encodeURIComponent(currentSessionId)}/messages`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
      );
      if (!response.ok) throw new Error(`Failed to post message (${response.status})`);
      await refreshSessions();
    } catch (error) {
      setSending(false);
      setStatus('Idle');
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, [currentSessionId, refreshSessions]);

  const handleApproval = useCallback(async (toolCallId: string, approved: boolean) => {
    if (!currentSessionId) return;
    try {
      await apiFetch(`/sessions/${encodeURIComponent(currentSessionId)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId, approved }),
      });
      setItems(prev => prev.map(item =>
        item.type === 'approval' && item.toolCallId === toolCallId
          ? { ...item, resolved: true, approved }
          : item
      ));
    } catch (error) {
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, [currentSessionId]);

  // Initial load
  useEffect(() => {
    refreshSessions().then(() => {
      // Auto-select or create session handled after sessions load
    });
    return () => closeEventSource();
  }, [refreshSessions, closeEventSource]);

  // Auto-select first session or create one after sessions load
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (initialLoadDone.current) return;
    if (sessions.length > 0 && !currentSessionId) {
      initialLoadDone.current = true;
      void selectSession(sessions[0].sessionId);
    } else if (sessions.length === 0 && !currentSessionId) {
      initialLoadDone.current = true;
      void createNewSession();
    }
  }, [sessions, currentSessionId, selectSession, createNewSession]);

  const currentSession = sessions.find(s => s.sessionId === currentSessionId);
  const sessionTitle = currentSession?.description || currentSession?.lastMessagePreview || currentSessionId || 'No session';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <p className="eyebrow">OpenHermit</p>
          <h1>Web Chat</h1>
          <p className="sidebar__meta">Agent: {connection.agentId}</p>
          <div className="sidebar__buttons">
            <button className="btn btn--primary" onClick={() => void createNewSession()}>New Session</button>
            <button className="btn btn--ghost" onClick={onDisconnect}>Disconnect</button>
          </div>
        </div>
        <SessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelect={sessionId => void selectSession(sessionId)}
        />
      </aside>

      <main className="chat">
        <header className="chat__header">
          <div>
            <p className="eyebrow">Current Session</p>
            <h2>{sessionTitle}</h2>
          </div>
          <p className="chat__status">{status}</p>
        </header>

        <ChatMessages items={items} onApproval={handleApproval} />

        <Composer onSend={sendMessage} disabled={sending || !currentSessionId} />
      </main>
    </div>
  );
}
