import { useEffect, useRef } from 'react';
import { apiFetch } from '../api';

// ─── Markdown renderer ─────────────────────────────────────────────────────

const renderMarkdown = (text: string): string => {
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => `<pre class="md-code-block"><code>${(code as string).trim()}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/^[*-] (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, '');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<p>(<(?:pre|h[2-4]|ul))/g, '$1');
  html = html.replace(/(<\/(?:pre|h[2-4]|ul)>)<\/p>/g, '$1');
  html = html.replace(/<br>(<(?:pre|h[2-4]|ul))/g, '$1');
  html = html.replace(/(<\/(?:pre|h[2-4]|ul)>)<br>/g, '$1');
  return html;
};

// ─── Types ─────────────────────────────────────────────────────────────────

export type ChatItem =
  | { type: 'user'; text: string; streaming: false }
  | { type: 'assistant'; text: string; streaming: boolean }
  | { type: 'event'; text: string; isError: boolean }
  | { type: 'tool'; tool: string; args?: unknown; phase: 'running' | 'done'; isError?: boolean; result?: string }
  | { type: 'approval'; toolName: string; toolCallId: string; args?: unknown; resolved: boolean; approved?: boolean };

interface Props {
  items: ChatItem[];
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
      <div className="message__title">Approval required · {item.toolName}</div>
      <div className="message__body">{formatArgs(item.args)}</div>
      <div className="approval-card__actions">
        <button className="btn btn--primary" onClick={() => void onApproval(item.toolCallId, true)}>Approve</button>
        <button className="btn btn--ghost" onClick={() => void onApproval(item.toolCallId, false)}>Deny</button>
      </div>
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────

export function ChatMessages({ items, onApproval }: Props) {
  const containerRef = useRef<HTMLElement>(null);

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

  return (
    <section className="chat__messages" ref={containerRef}>
      {items.map((item, i) => {
        switch (item.type) {
          case 'user':
            return (
              <article key={i} className="message message--user">
                <div className="message__title">You</div>
                <div className="message__body">{item.text}</div>
              </article>
            );
          case 'assistant':
            return (
              <article key={i} className="message message--assistant">
                <div className="message__title">OpenHermit</div>
                {item.streaming ? (
                  <div className="message__body">{item.text}</div>
                ) : (
                  <div className="message__body" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />
                )}
              </article>
            );
          case 'event':
            return (
              <div key={i} className={`event${item.isError ? ' event--error' : ''}`}>
                {item.isError ? `[error] ${item.text}` : item.text}
              </div>
            );
          case 'tool':
            return <ToolCard key={i} item={item} />;
          case 'approval':
            return <ApprovalCard key={i} item={item} onApproval={onApproval} />;
        }
      })}
    </section>
  );
}
