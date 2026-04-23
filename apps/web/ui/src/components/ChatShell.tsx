import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentWsClient, getDisplayName, type Connection, type SessionSummary, type HistoryMessage, type OutboundEvent } from '../api';
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
  const [status, setStatus] = useState('Connecting');
  const [sending, setSending] = useState(false);

  const wsRef = useRef<AgentWsClient | null>(null);
  const currentSessionRef = useRef<string | null>(null);
  const streamingTextRef = useRef('');

  currentSessionRef.current = currentSessionId;

  const handleEvent = useCallback((_eventId: number, sessionId: string, event: OutboundEvent) => {
    if (sessionId !== currentSessionRef.current) return;

    const dropThinking = (items: ChatItem[]) => items.filter(i => i.type !== 'thinking');

    switch (event.type) {
      case 'tool_call':
        setItems(prev => [...dropThinking(prev), { type: 'tool', tool: event.tool as string, args: event.args, phase: 'running' }]);
        break;

      case 'tool_result':
        setItems(prev => {
          const idx = prev.findLastIndex(i => i.type === 'tool' && i.tool === event.tool && i.phase !== 'done');
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              phase: 'done',
              isError: event.isError as boolean,
              result: (event.text as string) || (event.details ? JSON.stringify(event.details, null, 2) : ''),
            } as ChatItem;
            return updated;
          }
          return prev;
        });
        break;

      case 'tool_approval_required':
        setItems(prev => [...dropThinking(prev), {
          type: 'approval',
          toolName: event.toolName as string,
          toolCallId: event.toolCallId as string,
          args: event.args,
          resolved: false,
        }]);
        break;

      case 'text_delta':
        streamingTextRef.current += event.text as string;
        setItems(prev => {
          const clean = dropThinking(prev);
          const text = streamingTextRef.current;
          const last = clean[clean.length - 1];
          if (last?.type === 'assistant' && last.streaming) {
            const updated = [...clean];
            updated[updated.length - 1] = { type: 'assistant', text, streaming: true };
            return updated;
          }
          return [...clean, { type: 'assistant', text, streaming: true }];
        });
        break;

      case 'text_final': {
        const finalText = (event.text as string) || streamingTextRef.current;
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
        break;
      }

      case 'error':
        setItems(prev => [...dropThinking(prev), { type: 'event', text: event.message as string, isError: true }]);
        break;

      case 'agent_end':
        streamingTextRef.current = '';
        setSending(false);
        setStatus('Connected');
        wsRef.current?.listSessions().then(setSessions).catch(() => {});
        break;
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!wsRef.current) return;
    const list = await wsRef.current.listSessions();
    setSessions(list);
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    const ws = wsRef.current;
    if (!ws || sessionId === currentSessionRef.current) return;

    if (currentSessionRef.current) {
      await ws.unsubscribe(currentSessionRef.current);
    }

    setCurrentSessionId(sessionId);
    setItems([]);
    streamingTextRef.current = '';

    await ws.openSession(sessionId);

    const session = sessions.find(s => s.sessionId === sessionId);
    const lastEventId = session?.lastEventId ?? 0;

    const history: HistoryMessage[] = await ws.getHistory(sessionId);
    const historyItems: ChatItem[] = [];
    for (const entry of history) {
      if (entry.role === 'tool') {
        // Merge into existing tool card if it's for the same tool invocation
        const last = historyItems[historyItems.length - 1];
        if (last?.type === 'tool' && last.tool === entry.tool && last.phase !== 'done' && entry.toolPhase === 'result') {
          last.phase = 'done';
          last.isError = entry.toolIsError;
          last.result = entry.content || undefined;
        } else if (entry.toolPhase === 'result') {
          historyItems.push({
            type: 'tool', tool: entry.tool || '', args: entry.toolArgs,
            phase: 'done', isError: entry.toolIsError, result: entry.content || undefined,
          });
        } else {
          historyItems.push({
            type: 'tool', tool: entry.tool || '', args: entry.toolArgs,
            phase: 'running',
          });
        }
        continue;
      }
      if (entry.role === 'error') { historyItems.push({ type: 'event', text: entry.content, isError: true }); continue; }
      historyItems.push({ type: entry.role as 'user' | 'assistant', text: entry.content, streaming: false });
    }
    setItems(historyItems);

    await ws.subscribe(sessionId, lastEventId);
  }, [sessions]);

  const createNewSession = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws) return;

    if (currentSessionRef.current) {
      await ws.checkpoint(currentSessionRef.current, 'new_session').catch(() => {});
    }

    const sessionId = createSessionId();
    await ws.openSession(sessionId);
    await refreshSessions();
    await selectSession(sessionId);
  }, [refreshSessions, selectSession]);

  const sendMessage = useCallback(async (text: string) => {
    const ws = wsRef.current;
    const sessionId = currentSessionRef.current;
    if (!ws || !sessionId || !text.trim()) return;

    setItems(prev => [...prev, { type: 'user', text, streaming: false }, { type: 'thinking' }]);
    setSending(true);
    setStatus('Running');
    streamingTextRef.current = '';

    try {
      await ws.sendMessage(sessionId, text);
    } catch (error) {
      setSending(false);
      setStatus('Connected');
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, []);

  const handleApproval = useCallback(async (toolCallId: string, approved: boolean) => {
    const ws = wsRef.current;
    const sessionId = currentSessionRef.current;
    if (!ws || !sessionId) return;

    try {
      await ws.approve(sessionId, toolCallId, approved);
      setItems(prev => prev.map(item =>
        item.type === 'approval' && item.toolCallId === toolCallId
          ? { ...item, resolved: true, approved }
          : item
      ));
    } catch (error) {
      setItems(prev => [...prev, { type: 'event', text: error instanceof Error ? error.message : String(error), isError: true }]);
    }
  }, []);

  // Connect WS on mount
  useEffect(() => {
    const client = new AgentWsClient(handleEvent, (s) => {
      if (s === 'connected') setStatus('Connected');
      else if (s === 'connecting') setStatus('Connecting');
      else setStatus('Disconnected');
    });
    wsRef.current = client;

    client.connect()
      .then(() => client.listSessions())
      .then(setSessions)
      .catch(() => setStatus('Disconnected'));

    return () => {
      client.close();
      wsRef.current = null;
    };
  }, [handleEvent]);

  // Auto-select first session after sessions load
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (initialLoadDone.current) return;
    if (sessions.length > 0 && !currentSessionId) {
      initialLoadDone.current = true;
      void selectSession(sessions[0].sessionId);
    } else if (sessions.length === 0) {
      initialLoadDone.current = true;
    }
  }, [sessions, currentSessionId, selectSession]);

  const currentSession = sessions.find(s => s.sessionId === currentSessionId);
  const sessionTitle = currentSession?.description || currentSession?.lastMessagePreview || currentSessionId || 'No session';
  const isWebSession = !currentSession || currentSession.source?.kind === 'api' && currentSession.source?.platform === 'web';
  const readOnly = currentSession != null && !isWebSession;

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
        <div className="sidebar__footer">
          <div>
            <div className="sidebar__footer-name"><span className="sidebar__footer-dot" />{getDisplayName() || 'Anonymous'}</div>
            <div className="sidebar__footer-auth">Auth: device key · WS</div>
          </div>
        </div>
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

        {readOnly ? (
          <div className="composer composer--readonly">
            <span>Read-only — this session was created via {currentSession.source?.platform || currentSession.source?.kind || 'another channel'}</span>
          </div>
        ) : (
          <Composer onSend={sendMessage} disabled={sending || !currentSessionId} />
        )}
      </main>
    </div>
  );
}
