const state = {
  agentMeta: null,
  sessions: [],
  currentSessionId: null,
  source: null,
  eventSource: null,
  currentAssistantBody: null,
  currentTurnPending: false,
};

const agentMeta = document.getElementById('agent-meta');
const sessionsList = document.getElementById('sessions-list');
const sessionTitle = document.getElementById('session-title');
const connectionStatus = document.getElementById('connection-status');
const messages = document.getElementById('messages');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');
const sendButton = document.getElementById('send-button');
const newSessionButton = document.getElementById('new-session-button');

const createSessionId = () =>
  `web:${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

const formatArgs = (value) => {
  if (value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  const compact = JSON.stringify(value);
  return compact && compact.length <= 120
    ? compact
    : JSON.stringify(value, null, 2);
};

const relativeTime = (iso) => {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  return `${Math.round(diff / day)}d ago`;
};

const setStatus = (text) => {
  connectionStatus.textContent = text;
};

const clearMessages = () => {
  messages.innerHTML = '';
  state.currentAssistantBody = null;
};

const ensureEmptyState = () => {
  if (messages.childElementCount > 0) {
    return;
  }

  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.textContent =
    'Start a new session or resume an existing one from the sidebar. The transcript here will stream tool activity and assistant replies for the selected session.';
  messages.append(empty);
};

const removeEmptyState = () => {
  const empty = messages.querySelector('.empty-state');
  if (empty) {
    empty.remove();
  }
};

const appendMessage = (role, text) => {
  removeEmptyState();
  const article = document.createElement('article');
  article.className = `message message--${role}`;

  const title = document.createElement('div');
  title.className = 'message__title';
  title.textContent = role === 'user' ? 'You' : 'OpenHermit';

  const body = document.createElement('div');
  body.className = 'message__body';
  body.textContent = text;

  article.append(title, body);
  messages.append(article);
  messages.scrollTop = messages.scrollHeight;

  return body;
};

const appendEvent = (text, type = '') => {
  removeEmptyState();
  const line = document.createElement('div');
  line.className = type ? `event event--${type}` : 'event';
  line.textContent = text;
  messages.append(line);
  messages.scrollTop = messages.scrollHeight;
  return line;
};

const appendApprovalCard = (toolName, toolCallId, args) => {
  const card = document.createElement('div');
  card.className = 'approval-card';

  const label = document.createElement('div');
  label.className = 'message__title';
  label.textContent = `Approval required · ${toolName}`;

  const body = document.createElement('div');
  body.className = 'message__body';
  body.textContent = formatArgs(args) || 'No arguments';

  const actions = document.createElement('div');
  actions.className = 'approval-card__actions';

  const approve = document.createElement('button');
  approve.className = 'button button--primary';
  approve.textContent = 'Approve';

  const deny = document.createElement('button');
  deny.className = 'button button--ghost';
  deny.textContent = 'Deny';

  const resolve = async (approved) => {
    approve.disabled = true;
    deny.disabled = true;

    try {
      await fetch(`/api/sessions/${encodeURIComponent(state.currentSessionId)}/approve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ toolCallId, approved }),
      });

      appendEvent(
        approved ? `[approval] approved ${toolName}` : `[approval] denied ${toolName}`,
      );
      card.remove();
    } catch (error) {
      appendEvent(
        `[error] ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      approve.disabled = false;
      deny.disabled = false;
    }
  };

  approve.addEventListener('click', () => void resolve(true));
  deny.addEventListener('click', () => void resolve(false));

  actions.append(approve, deny);
  card.append(label, body, actions);
  messages.append(card);
  messages.scrollTop = messages.scrollHeight;
};

const renderSessions = () => {
  sessionsList.innerHTML = '';

  if (state.sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No web sessions yet. Start one to begin chatting.';
    sessionsList.append(empty);
    return;
  }

  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-card';

    if (session.sessionId === state.currentSessionId) {
      button.classList.add('is-active');
    }

    const title = document.createElement('div');
    title.className = 'session-card__title';
    title.textContent =
      session.description ||
      session.lastMessagePreview ||
      session.sessionId;

    const meta = document.createElement('div');
    meta.className = 'session-card__meta';
    meta.textContent = `${relativeTime(session.lastActivityAt)} · ${session.messageCount} messages`;

    const preview = document.createElement('p');
    preview.className = 'session-card__preview';
    preview.textContent = session.lastMessagePreview || 'No preview yet';

    button.append(title, meta, preview);
    button.addEventListener('click', () => void selectSession(session.sessionId));
    sessionsList.append(button);
  }
};

const refreshSessions = async () => {
  const response = await fetch('/api/sessions?kind=web&limit=50');

  if (!response.ok) {
    throw new Error(`Failed to list sessions (${response.status})`);
  }

  state.sessions = await response.json();
  renderSessions();
};

const connectToSessionStream = (sessionId) => {
  if (state.eventSource) {
    state.eventSource.close();
  }

  clearMessages();
  ensureEmptyState();
  state.currentAssistantBody = null;
  state.currentTurnPending = false;

  const source = new EventSource(`/api/events?sessionId=${encodeURIComponent(sessionId)}`);
  state.eventSource = source;
  state.source = source;
  setStatus('Streaming');

  source.addEventListener('tool_requested', (event) => {
    const payload = JSON.parse(event.data);
    const formatted = formatArgs(payload.args);
    appendEvent(
      formatted
        ? `[tool requested] ${payload.tool} ${formatted}`
        : `[tool requested] ${payload.tool}`,
    );
  });

  source.addEventListener('tool_started', (event) => {
    const payload = JSON.parse(event.data);
    const formatted = formatArgs(payload.args);
    appendEvent(
      formatted ? `[tool] ${payload.tool} ${formatted}` : `[tool] ${payload.tool}`,
    );
  });

  source.addEventListener('tool_result', (event) => {
    const payload = JSON.parse(event.data);
    appendEvent(payload.isError ? `[tool error] ${payload.tool}` : `[tool result] ${payload.tool}`);
  });

  source.addEventListener('tool_approval_required', (event) => {
    const payload = JSON.parse(event.data);
    appendApprovalCard(payload.toolName, payload.toolCallId, payload.args);
  });

  source.addEventListener('text_delta', (event) => {
    const payload = JSON.parse(event.data);
    if (!state.currentAssistantBody) {
      state.currentAssistantBody = appendMessage('assistant', '');
    }
    state.currentAssistantBody.textContent += payload.text;
    messages.scrollTop = messages.scrollHeight;
  });

  source.addEventListener('text_final', (event) => {
    const payload = JSON.parse(event.data);
    if (!state.currentAssistantBody) {
      state.currentAssistantBody = appendMessage('assistant', payload.text);
    } else if (!state.currentAssistantBody.textContent) {
      state.currentAssistantBody.textContent = payload.text;
    }
    messages.scrollTop = messages.scrollHeight;
  });

  source.addEventListener('error', (event) => {
    if (event?.data) {
      const payload = JSON.parse(event.data);
      appendEvent(`[error] ${payload.message}`, 'error');
    }
  });

  source.addEventListener('agent_end', async () => {
    state.currentAssistantBody = null;
    state.currentTurnPending = false;
    sendButton.disabled = false;
    setStatus('Idle');
    await refreshSessions();
  });

  source.addEventListener('ready', () => {
    setStatus('Connected');
  });

  source.onerror = () => {
    setStatus('Reconnecting...');
  };
};

const selectSession = async (sessionId) => {
  if (state.currentSessionId === sessionId && state.eventSource) {
    return;
  }

  state.currentSessionId = sessionId;
  sessionTitle.textContent = sessionId;
  renderSessions();

  await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId,
      source: {
        kind: 'web',
        interactive: true,
      },
    }),
  });

  const summary = state.sessions.find((session) => session.sessionId === sessionId);
  sessionTitle.textContent = summary?.description || summary?.lastMessagePreview || sessionId;
  connectToSessionStream(sessionId);
};

const createAndSelectSession = async () => {
  const sessionId = createSessionId();
  await fetch('/api/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId,
      source: {
        kind: 'web',
        interactive: true,
      },
    }),
  });
  await refreshSessions();
  await selectSession(sessionId);
};

composer.addEventListener('submit', async (event) => {
  event.preventDefault();

  const text = composerInput.value.trim();

  if (!text || !state.currentSessionId) {
    return;
  }

  appendMessage('user', text);
  composerInput.value = '';
  state.currentAssistantBody = null;
  state.currentTurnPending = true;
  sendButton.disabled = true;
  setStatus('Running');

  try {
    const response = await fetch(
      `/api/sessions/${encodeURIComponent(state.currentSessionId)}/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to post message (${response.status})`);
    }

    await refreshSessions();
  } catch (error) {
    state.currentTurnPending = false;
    sendButton.disabled = false;
    setStatus('Idle');
    appendEvent(
      `[error] ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
  }
});

composerInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();

  if (sendButton.disabled) {
    return;
  }

  composer.requestSubmit();
});

newSessionButton.addEventListener('click', () => void createAndSelectSession());

const main = async () => {
  const bootstrapResponse = await fetch('/api/bootstrap');

  if (!bootstrapResponse.ok) {
    throw new Error(`Failed to bootstrap web client (${bootstrapResponse.status})`);
  }

  state.agentMeta = await bootstrapResponse.json();
  agentMeta.textContent = `${state.agentMeta.agentId} · API ${state.agentMeta.agentApiPort}`;

  await refreshSessions();

  if (state.sessions.length > 0) {
    await selectSession(state.sessions[0].sessionId);
  } else {
    await createAndSelectSession();
  }
};

main().catch((error) => {
  setStatus('Error');
  appendEvent(
    `[error] ${error instanceof Error ? error.message : String(error)}`,
    'error',
  );
});
