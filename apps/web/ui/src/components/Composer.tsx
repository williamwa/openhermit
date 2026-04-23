import { useState, useRef, type FormEvent, type KeyboardEvent } from 'react';

interface Props {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function Composer({ onSend, disabled }: Props) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (disabled) return;
    const trimmed = text.trim();
    if (trimmed) {
      onSend(trimmed);
      setText('');
    }
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        rows={3}
        placeholder="Ask OpenHermit to inspect files, run code, search memory, or continue a previous thread..."
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="composer__actions">
        <p className="composer__hint">Press Enter to send, Shift+Enter for newline.</p>
        <button className="btn btn--primary" type="submit" disabled={disabled || !text.trim()}>
          Send
        </button>
      </div>
    </form>
  );
}
