import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentWsClient, fetchAgentInfo, getDisplayName, type Connection, type SessionSummary, type HistoryMessage, type OutboundEvent } from '../api';
import { SessionList } from './SessionList';
import { ChatMessages, type ChatItem } from './ChatMessages';
import { Composer } from './Composer';
import { ManagePanel, type ManageTab } from './ManagePanel';

const createSessionId = () =>
  `web:${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

type View = 'chat' | 'manage';
type ManageTab = 'skills' | 'mcp' | 'schedules';

const MANAGE_TABS: ManageTab[] = ['skills', 'mcp', 'schedules'];

type Route =
  | { view: 'chat'; sessionId: string | null }
  | { view: 'manage'; tab: ManageTab };

const parseRoute = (pathname: string): Route => {
  if (pathname.startsWith('/manage')) {
    const tab = pathname.split('/')[2] as ManageTab | undefined;
    return { view: 'manage', tab: MANAGE_TABS.includes(tab!) ? tab! : 'skills' };
  }
  if (pathname.startsWith('/chat/')) {
    const sessionId = decodeURIComponent(pathname.slice(6));
    return sessionId ? { view: 'chat', sessionId } : { view: 'chat', sessionId: null };
  }
  return { view: 'chat', sessionId: null };
};

const routeToPath = (route: Route): string => {
  if (route.view === 'manage') return `/manage/${route.tab}`;
  if (route.sessionId) return `/chat/${encodeURIComponent(route.sessionId)}`;
  return '/';
};

interface Props {
  connection: Connection;
  role: string | null;
  onDisconnect: () => void;
}

export function ChatShell({ connection, role, onDisconnect }: Props) {
  const initialRoute = parseRoute(window.location.pathname);
  const [view, setView] = useState<View>(initialRoute.view);
  const [manageTab, setManageTab] = useState<ManageTab>(initialRoute.view === 'manage' ? initialRoute.tab : 'skills');
  const isOwner = role === 'owner';
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const initialSessionId = initialRoute.view === 'chat' ? initialRoute.sessionId : null;
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [status, setStatus] = useState('Connecting');
  const [sending, setSending] = useState(false);

  const wsRef = useRef<AgentWsClient | null>(null);
  const currentSessionRef = useRef<string | null>(null);
  const streamingTextRef = useRef('');
  const skipPushRef = useRef(false);

  currentSessionRef.current = currentSessionId;

  // Sync URL when view/session/tab changes
  useEffect(() => {
    if (skipPushRef.current) { skipPushRef.current = false; return; }
    const route: Route = view === 'manage'
      ? { view: 'manage', tab: manageTab }
      : { view: 'chat', sessionId: currentSessionId };
    const path = routeToPath(route);
    if (window.location.pathname !== path) {
      history.pushState(null, '', path);
    }
  }, [view, currentSessionId, manageTab]);

  // Listen to back/forward navigation
  useEffect(() => {
    const onPopState = () => {
      skipPushRef.current = true;
      const route = parseRoute(window.location.pathname);
      setView(route.view);
      if (route.view === 'manage') {
        setManageTab(route.tab);
      } else if (route.sessionId && route.sessionId !== currentSessionRef.current) {
        void selectSessionById(route.sessionId);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const selectSessionById = useCallback(async (sessionId: string) => {
    const ws = wsRef.current;
    if (!ws || sessionId === currentSessionRef.current) return;
    if (currentSessionRef.current) {
      await ws.unsubscribe(currentSessionRef.current);
    }
    setCurrentSessionId(sessionId);
    setView('chat');
    setItems([]);
    streamingTextRef.current = '';
    await ws.openSession(sessionId);
    const history: HistoryMessage[] = await ws.getHistory(sessionId);
    const historyItems: ChatItem[] = [];
    for (const entry of history) {
      if (entry.role === 'tool') {
        const last = historyItems[historyItems.length - 1];
        if (last?.type === 'tool' && last.tool === entry.tool && last.phase !== 'done' && entry.toolPhase === 'result') {
          last.phase = 'done';
          last.isError = entry.toolIsError;
          last.result = entry.content || undefined;
        } else if (entry.toolPhase === 'result') {
          historyItems.push({ type: 'tool', tool: entry.tool || '', args: entry.toolArgs, phase: 'done', isError: entry.toolIsError, result: entry.content || undefined });
        } else {
          historyItems.push({ type: 'tool', tool: entry.tool || '', args: entry.toolArgs, phase: 'running' });
        }
        continue;
      }
      if (entry.role === 'error') { historyItems.push({ type: 'event', text: entry.content, isError: true }); continue; }
      historyItems.push({ type: entry.role as 'user' | 'assistant', text: entry.content, streaming: false, name: entry.name });
      if (entry.role === 'assistant' && entry.name) setAgentName(entry.name);
    }
    setItems(historyItems);
    const allSessions = await ws.listSessions();
    const sess = allSessions.find(s => s.sessionId === sessionId);
    await ws.subscribe(sessionId, sess?.lastEventId ?? 0);
  }, []);

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

  const selectSession = selectSessionById;

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

  const deleteSession = useCallback(async (sessionId: string) => {
    const ws = wsRef.current;
    if (!ws) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;
    try {
      await ws.deleteSession(sessionId);
      if (currentSessionRef.current === sessionId) {
        setCurrentSessionId(null);
        setItems([]);
        history.replaceState(null, '', '/');
      }
      await refreshSessions();
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
    }
  }, [refreshSessions]);

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

    client.setOnReconnect(() => {
      client.listSessions().then(setSessions).catch(() => {});
    });
    client.startVisibilityCheck();

    client.connect()
      .then(() => Promise.all([
        client.listSessions().then(setSessions),
        fetchAgentInfo().then(info => setAgentName(info.name)).catch(() => {}),
      ]))
      .catch(() => setStatus('Disconnected'));

    return () => {
      client.close();
      wsRef.current = null;
    };
  }, [handleEvent]);

  // Auto-select session after sessions load (from URL or first available)
  const initialLoadDone = useRef(false);
  useEffect(() => {
    if (initialLoadDone.current || view === 'manage') return;
    if (sessions.length > 0 && !currentSessionRef.current) {
      initialLoadDone.current = true;
      if (initialSessionId && sessions.some(s => s.sessionId === initialSessionId)) {
        void selectSession(initialSessionId);
      } else {
        void selectSession(sessions[0].sessionId);
      }
    } else if (sessions.length > 0 && currentSessionRef.current) {
      initialLoadDone.current = true;
    } else if (sessions.length === 0) {
      initialLoadDone.current = true;
    }
  }, [sessions, selectSession, view, initialSessionId]);

  const currentSession = sessions.find(s => s.sessionId === currentSessionId);
  const sessionTitle = currentSession?.description || currentSession?.lastMessagePreview || currentSessionId || 'No session';
  const isWebSession = !currentSession || currentSession.source?.kind === 'api' && currentSession.source?.platform === 'web';
  const readOnly = currentSession != null && !isWebSession;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="sidebar__brand">
            <img src="/logo.png" alt="" className="sidebar__logo" />
            <div>
              <h1 className="sidebar__brand-name">OpenHermit</h1>
              <p className="sidebar__meta">Agent: {agentName || connection.agentId}</p>
            </div>
          </div>
          <div className="sidebar__buttons">
            {view === 'manage' ? (
              <button className="btn btn--primary" onClick={() => { setView('chat'); }}>Back to Chat</button>
            ) : (
              <button className="btn btn--primary" onClick={() => void createNewSession()}>New Session</button>
            )}
            {isOwner && view === 'chat' && (
              <button className="btn btn--ghost" onClick={() => { setView('manage'); setManageTab('skills'); }}>Manage</button>
            )}
          </div>
        </div>
        <SessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          onSelect={sessionId => void selectSession(sessionId)}
          onDelete={sessionId => void deleteSession(sessionId)}
        />
        <div className="sidebar__footer">
          <div>
            <div className="sidebar__footer-name"><span className="sidebar__footer-dot" />{getDisplayName() || 'Anonymous'}</div>
            <div className="sidebar__footer-auth">Auth: device key · WS</div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={onDisconnect}>Disconnect</button>
        </div>
      </aside>

      <main className="chat">
        {view === 'manage' ? (
          <>
            <header className="chat__header">
              <div>
                <p className="eyebrow">Agent Management</p>
                <h2>{connection.agentId}</h2>
              </div>
            </header>
            <div className="chat__manage-area">
              <ManagePanel tab={manageTab} onTabChange={setManageTab} />
            </div>
          </>
        ) : (
          <>
            <header className="chat__header">
              <div>
                <p className="eyebrow">Current Session</p>
                <h2>{sessionTitle}</h2>
              </div>
              <p className="chat__status">{status}</p>
            </header>

            <ChatMessages items={items} agentName={agentName ?? undefined} onApproval={handleApproval} />

            {readOnly ? (
              <div className="composer composer--readonly">
                <span>Read-only — this session was created via {currentSession.source?.platform || currentSession.source?.kind || 'another channel'}</span>
              </div>
            ) : (
              <Composer onSend={sendMessage} disabled={sending || !currentSessionId} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
