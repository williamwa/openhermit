import { useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import remend from 'remend';
import { apiFetch } from '../api';

// ─── Markdown renderer ─────────────────────────────────────────────────────

const renderMarkdown = (text: string, streaming = false): string => {
  const src = streaming ? remend(text, { linkMode: 'text-only' }) : text;
  return marked.parse(src, { async: false }) as string;
};

// ─── Types ─────────────────────────────────────────────────────────────────

export type ChatItem =
  | { type: 'user'; text: string; streaming: false; name?: string }
  | { type: 'assistant'; text: string; streaming: boolean; name?: string }
  | { type: 'event'; text: string; isError: boolean }
  | { type: 'tool'; tool: string; args?: unknown; phase: 'running' | 'done'; isError?: boolean; result?: string }
  | { type: 'approval'; toolName: string; toolCallId: string; args?: unknown; resolved: boolean; approved?: boolean }
  | { type: 'thinking'; text?: string; streaming?: boolean }
  | { type: 'introspection'; tools: Extract<ChatItem, { type: 'tool' }>[]; summary?: string };

interface Props {
  items: ChatItem[];
  agentName?: string;
  onApproval: (toolCallId: string, approved: boolean) => Promise<void>;
}

// ─── Components ────────────────────────────────────────────────────────────

function ToolCard({ item }: { item: Extract<ChatItem, { type: 'tool' }> }) {
  const icon = item.phase === 'done'
    ? (item.isError ? '✗' : '✓')
    : (item.phase === 'running' ? '●' : '○');
  const statusText = item.phase === 'done'
    ? (item.isError ? 'error' : 'done')
    : item.phase;

  const doneClass = item.phase === 'done' ? (item.isError ? 'tool-card--error' : 'tool-card--done') : '';

  const formatArgs = (value: unknown): string => {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    const compact = JSON.stringify(value);
    return compact.length <= 120 ? compact : JSON.stringify(value, null, 2);
  };

  const hasBody = item.args != null || item.result;

  return (
    <details className={`tool-card ${doneClass}`} open={item.phase !== 'done'}>
      <summary className="tool-card__header">
        <span className="tool-card__icon">{icon}</span>
        <span className="tool-card__name">{item.tool}</span>
        <span className={`tool-card__status${item.phase === 'done' ? (item.isError ? ' tool-card__status--error' : ' tool-card__status--done') : ''}`}>
          {statusText}
        </span>
      </summary>
      {hasBody && (
        <div className="tool-card__body">
          {item.args != null && (
            <pre className="tool-card__args">{formatArgs(item.args)}</pre>
          )}
          {item.result && (
            <pre className="tool-card__result">
              {item.result.length > 800 ? item.result.slice(0, 800) + '...' : item.result}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}

function ApprovalCard({ item, onApproval }: { item: Extract<ChatItem, { type: 'approval' }>; onApproval: Props['onApproval'] }) {
  if (item.resolved) {
    return (
      <div className="event">
        {item.approved ? `[approved] ${item.toolName}` : `[denied] ${item.toolName}`}
      </div>
    );
  }

  const formatArgs = (value: unknown): string => {
    if (value === undefined || value === null) return 'No arguments';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  };

  return (
    <div className="approval-card">
      <div className="approval-card__title">Approval required · {item.toolName}</div>
      <div className="approval-card__body">{formatArgs(item.args)}</div>
      <div className="approval-card__actions">
        <button className="btn btn--primary" onClick={() => void onApproval(item.toolCallId, true)}>Approve</button>
        <button className="btn btn--ghost" onClick={() => void onApproval(item.toolCallId, false)}>Deny</button>
      </div>
    </div>
  );
}

// ─── Turn grouping ────────────────────────────────────────────────────────

type Turn =
  | { kind: 'user'; items: Extract<ChatItem, { type: 'user' }>[] }
  | { kind: 'assistant'; items: ChatItem[] }
  | { kind: 'event'; item: Extract<ChatItem, { type: 'event' }> }
  | { kind: 'introspection'; item: Extract<ChatItem, { type: 'introspection' }> };

const isAssistantItem = (item: ChatItem) =>
  item.type === 'assistant' || item.type === 'tool' || item.type === 'approval' || item.type === 'thinking';

function groupIntoTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  for (const item of items) {
    if (item.type === 'user') {
      turns.push({ kind: 'user', items: [item] });
    } else if (item.type === 'event') {
      turns.push({ kind: 'event', item });
    } else if (item.type === 'introspection') {
      turns.push({ kind: 'introspection', item });
    } else if (isAssistantItem(item)) {
      const last = turns[turns.length - 1];
      if (last?.kind === 'assistant') {
        last.items.push(item);
      } else {
        turns.push({ kind: 'assistant', items: [item] });
      }
    }
  }
  return turns;
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function ChatMessages({ items, agentName, onApproval }: Props) {
  const containerRef = useRef<HTMLElement>(null);
  const displayAgentName = agentName || 'Assistant';

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [items]);

  if (items.length === 0) {
    return (
      <section className="chat__messages" ref={containerRef}>
        <div className="empty-state">Start a conversation or select a session from the sidebar.</div>
      </section>
    );
  }

  const turns = groupIntoTurns(items);

  return (
    <section className="chat__messages" ref={containerRef}>
      {turns.map((turn, ti) => {
        if (turn.kind === 'user') {
          const item = turn.items[0];
          return (
            <article key={ti} className="message message--user">
              <div className="message__title">{item.name || 'You'}</div>
              <div className="message__body">{item.text}</div>
            </article>
          );
        }

        if (turn.kind === 'event') {
          return (
            <div key={ti} className={`event${turn.item.isError ? ' event--error' : ''}`}>
              {turn.item.isError ? `[error] ${turn.item.text}` : turn.item.text}
            </div>
          );
        }

        if (turn.kind === 'introspection') {
          const { tools, summary } = turn.item;
          return (
            <details key={ti} className="introspection-block">
              <summary className="introspection-block__header">
                Introspection{summary ? ` — ${summary}` : ''}
              </summary>
              <div className="introspection-block__body">
                {tools.map((tool, ii) => <ToolCard key={ii} item={tool} />)}
              </div>
            </details>
          );
        }

        const nameItem = turn.items.find(i => i.type === 'assistant' && i.name);
        const turnName = (nameItem as any)?.name || displayAgentName;

        return (
          <article key={ti} className="message message--assistant">
            <div className="message__title">{turnName}</div>
            {turn.items.map((item, ii) => {
              switch (item.type) {
                case 'assistant':
                  return (
                    <div key={ii} className="message__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text, item.streaming) }} />
                  );
                case 'tool':
                  return <ToolCard key={ii} item={item} />;
                case 'approval':
                  return <ApprovalCard key={ii} item={item} onApproval={onApproval} />;
                case 'thinking':
                  return item.text ? (
                    <details key={ii} className="thinking-block" open={item.streaming}>
                      <summary className="thinking-block__header">
                        {item.streaming ? <>Thinking<span className="thinking-dots" /></> : 'Thinking'}
                      </summary>
                      <div className="thinking-block__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text, item.streaming) }} />
                    </details>
                  ) : (
                    <div key={ii} className="message__body thinking-indicator">Thinking<span className="thinking-dots" /></div>
                  );
              }
            })}
          </article>
        );
      })}
    </section>
  );
}
