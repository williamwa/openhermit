// ─── Storage ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'openhermit_connection';
const DEVICE_ID_KEY = 'openhermit_device_id';

const getDeviceId = () => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `web:${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

const loadConnection = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
};

const saveConnection = (conn) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
};

const clearConnection = () => {
  localStorage.removeItem(STORAGE_KEY);
};

// ─── Connection state ───────────────────────────────────────────────────────

let apiBase = '';
let authHeaders = {};

const setConnection = (conn) => {
  const base = conn.gatewayUrl.replace(/\/+$/, '');
  apiBase = `${base}/agents/${encodeURIComponent(conn.agentId)}`;
  authHeaders = {
    ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}),
    'x-device-id': getDeviceId(),
  };
};

// ─── Fetch helper ───────────────────────────────────────────────────────────

const apiFetch = (path, options = {}) => {
  const headers = { ...authHeaders, ...(options.headers || {}) };
  return fetch(`${apiBase}${path}`, { ...options, headers });
};

// ─── Connect screen ─────────────────────────────────────────────────────────

const connectScreen = document.getElementById('connect-screen');
const connectForm = document.getElementById('connect-form');
const connectGatewayUrl = document.getElementById('connect-gateway-url');
const connectAgentId = document.getElementById('connect-agent-id');
const connectToken = document.getElementById('connect-token');
const connectError = document.getElementById('connect-error');
const connectButton = document.getElementById('connect-button');

// ─── Chat elements ──────────────────────────────────────────────────────────

const chatShell = document.getElementById('chat-shell');
const agentMeta = document.getElementById('agent-meta');
const sessionsList = document.getElementById('sessions-list');
const sessionTitle = document.getElementById('session-title');
const connectionStatus = document.getElementById('connection-status');
const messagesEl = document.getElementById('messages');
const composer = document.getElementById('composer');
const composerInput = document.getElementById('composer-input');
const sendButton = document.getElementById('send-button');
const newSessionButton = document.getElementById('new-session-button');
const disconnectButton = document.getElementById('disconnect-button');

// ─── Chat state ─────────────────────────────────────────────────────────────

const state = {
  sessions: [],
  currentSessionId: null,
  currentEventId: 0,
  eventSource: null,
  currentAssistantBody: null,
  currentTurnPending: false,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const createSessionId = () =>
  `web:${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;

const formatArgs = (value) => {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  const compact = JSON.stringify(value);
  return compact && compact.length <= 120 ? compact : JSON.stringify(value, null, 2);
};

const relativeTime = (iso) => {
  const diff = Date.now() - new Date(iso).getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.round(diff / minute)}m ago`;
  if (diff < day) return `${Math.round(diff / hour)}h ago`;
  return `${Math.round(diff / day)}d ago`;
};

const setStatus = (text) => { connectionStatus.textContent = text; };

const clearMessages = () => {
  messagesEl.innerHTML = '';
  state.currentAssistantBody = null;
};

const ensureEmptyState = () => {
  if (messagesEl.childElementCount > 0) return;
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.textContent = 'Start a new session or resume an existing one from the sidebar.';
  messagesEl.append(el);
};

const removeEmptyState = () => {
  const el = messagesEl.querySelector('.empty-state');
  if (el) el.remove();
};

const appendMessage = (role, text) => {
  removeEmptyState();
  const article = document.createElement('article');
  article.className = `message message--${role}`;

  const title = document.createElement('div');
  title.className = 'message__title';
  title.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'OpenHermit' : 'Error';

  const body = document.createElement('div');
  body.className = 'message__body';
  body.textContent = text;

  article.append(title, body);
  messagesEl.append(article);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return body;
};

const renderHistory = (history) => {
  clearMessages();
  if (history.length === 0) { ensureEmptyState(); return; }
  for (const entry of [...history].reverse()) {
    if (entry.role === 'error') { appendEvent(`[error] ${entry.content}`, 'error'); continue; }
    appendMessage(entry.role, entry.content);
  }
};

const appendEvent = (text, type = '') => {
  removeEmptyState();
  const line = document.createElement('div');
  line.className = type ? `event event--${type}` : 'event';
  line.textContent = text;
  messagesEl.append(line);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return line;
};

// Tool call cards keyed by tool name — tool_started creates, tool_result updates.
const activeToolCards = new Map();

const appendToolCard = (toolName, args, phase) => {
  removeEmptyState();

  const card = document.createElement('div');
  card.className = 'tool-card';

  const header = document.createElement('div');
  header.className = 'tool-card__header';

  const icon = document.createElement('span');
  icon.className = 'tool-card__icon';
  icon.textContent = phase === 'requested' ? '\u25cb' : '\u25cf'; // ○ or ●

  const name = document.createElement('span');
  name.className = 'tool-card__name';
  name.textContent = toolName;

  const status = document.createElement('span');
  status.className = 'tool-card__status';
  status.textContent = phase === 'requested' ? 'pending' : 'running';

  header.append(icon, name, status);
  card.append(header);

  if (args !== undefined && args !== null) {
    const argsEl = document.createElement('pre');
    argsEl.className = 'tool-card__args';
    argsEl.textContent = typeof args === 'string' ? args : JSON.stringify(args, null, 2);
    card.append(argsEl);
  }

  const resultEl = document.createElement('pre');
  resultEl.className = 'tool-card__result';
  resultEl.hidden = true;
  card.append(resultEl);

  messagesEl.append(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  return { card, status, icon, resultEl };
};

const updateToolCardResult = (handle, isError, text, details) => {
  handle.status.textContent = isError ? 'error' : 'done';
  handle.status.className = isError
    ? 'tool-card__status tool-card__status--error'
    : 'tool-card__status tool-card__status--done';
  handle.icon.textContent = isError ? '\u2717' : '\u2713'; // ✗ or ✓
  handle.card.classList.toggle('tool-card--error', isError);
  handle.card.classList.toggle('tool-card--done', !isError);

  const output = text || (details !== undefined ? (typeof details === 'string' ? details : JSON.stringify(details, null, 2)) : '');
  if (output) {
    handle.resultEl.textContent = output.length > 800 ? output.slice(0, 800) + '...' : output;
    handle.resultEl.hidden = false;
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
      await apiFetch(`/sessions/${encodeURIComponent(state.currentSessionId)}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolCallId, approved }),
      });
      appendEvent(approved ? `[approval] approved ${toolName}` : `[approval] denied ${toolName}`);
      card.remove();
    } catch (error) {
      appendEvent(`[error] ${error instanceof Error ? error.message : String(error)}`, 'error');
      approve.disabled = false;
      deny.disabled = false;
    }
  };

  approve.addEventListener('click', () => void resolve(true));
  deny.addEventListener('click', () => void resolve(false));
  actions.append(approve, deny);
  card.append(label, body, actions);
  messagesEl.append(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
};

// ─── Sessions ───────────────────────────────────────────────────────────────

const renderSessions = () => {
  sessionsList.innerHTML = '';
  if (state.sessions.length === 0) {
    const el = document.createElement('div');
    el.className = 'empty-state';
    el.textContent = 'No web sessions yet. Start one to begin chatting.';
    sessionsList.append(el);
    return;
  }

  for (const session of state.sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-card';
    if (session.sessionId === state.currentSessionId) button.classList.add('is-active');

    const title = document.createElement('div');
    title.className = 'session-card__title';
    title.textContent = session.description || session.lastMessagePreview || session.sessionId;

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
  const response = await apiFetch('/sessions?kind=web&limit=50');
  if (!response.ok) throw new Error(`Failed to list sessions (${response.status})`);
  state.sessions = await response.json();
  renderSessions();
};

// ─── SSE ────────────────────────────────────────────────────────────────────

const connectToSessionStream = (sessionId) => {
  if (state.eventSource) state.eventSource.close();
  state.currentAssistantBody = null;
  state.currentTurnPending = false;

  const url = `${apiBase}/sessions/${encodeURIComponent(sessionId)}/events`;
  const source = new EventSource(url);
  state.eventSource = source;
  setStatus('Streaming');

  const guard = (handler) => (event) => {
    const eventId = Number.parseInt(event.lastEventId || '0', 10);
    if (eventId !== 0 && eventId <= state.currentEventId) return;
    state.currentEventId = Math.max(state.currentEventId, eventId || 0);
    handler(event);
  };

  source.addEventListener('tool_requested', guard((event) => {
    const p = JSON.parse(event.data);
    const handle = appendToolCard(p.tool, p.args, 'requested');
    activeToolCards.set(p.tool, handle);
  }));

  source.addEventListener('tool_started', guard((event) => {
    const p = JSON.parse(event.data);
    const existing = activeToolCards.get(p.tool);
    if (existing) {
      existing.status.textContent = 'running';
      existing.icon.textContent = '\u25cf';
    } else {
      const handle = appendToolCard(p.tool, p.args, 'started');
      activeToolCards.set(p.tool, handle);
    }
  }));

  source.addEventListener('tool_result', guard((event) => {
    const p = JSON.parse(event.data);
    const handle = activeToolCards.get(p.tool);
    if (handle) {
      updateToolCardResult(handle, p.isError, p.text, p.details);
      activeToolCards.delete(p.tool);
    } else {
      appendEvent(p.isError ? `[tool error] ${p.tool}` : `[tool result] ${p.tool}`);
    }
  }));

  source.addEventListener('tool_approval_required', guard((event) => {
    const p = JSON.parse(event.data);
    appendApprovalCard(p.toolName, p.toolCallId, p.args);
  }));

  source.addEventListener('text_delta', guard((event) => {
    const p = JSON.parse(event.data);
    if (!state.currentAssistantBody) state.currentAssistantBody = appendMessage('assistant', '');
    state.currentAssistantBody.textContent += p.text;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }));

  source.addEventListener('text_final', guard((event) => {
    const p = JSON.parse(event.data);
    if (!state.currentAssistantBody) {
      state.currentAssistantBody = appendMessage('assistant', p.text);
    } else if (!state.currentAssistantBody.textContent) {
      state.currentAssistantBody.textContent = p.text;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }));

  source.addEventListener('error', guard((event) => {
    if (event?.data) {
      const p = JSON.parse(event.data);
      appendEvent(`[error] ${p.message}`, 'error');
    }
  }));

  source.addEventListener('agent_end', guard(async () => {
    state.currentAssistantBody = null;
    state.currentTurnPending = false;
    activeToolCards.clear();
    sendButton.disabled = false;
    setStatus('Idle');
    await refreshSessions();
  }));

  source.addEventListener('ready', () => setStatus('Connected'));
  source.onerror = () => setStatus('Reconnecting...');
};

// ─── Session selection ──────────────────────────────────────────────────────

const selectSession = async (sessionId) => {
  if (state.currentSessionId === sessionId && state.eventSource) return;

  state.currentSessionId = sessionId;
  state.currentEventId = 0;
  sessionTitle.textContent = sessionId;
  renderSessions();

  await apiFetch('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, source: { kind: 'web', interactive: true }, metadata: {} }),
  });

  const summary = state.sessions.find((s) => s.sessionId === sessionId);
  state.currentEventId = summary?.lastEventId ?? 0;
  sessionTitle.textContent = summary?.description || summary?.lastMessagePreview || sessionId;

  const historyResponse = await apiFetch(`/sessions/${encodeURIComponent(sessionId)}/messages`);
  if (!historyResponse.ok) throw new Error(`Failed to load session history (${historyResponse.status})`);
  renderHistory(await historyResponse.json());
  connectToSessionStream(sessionId);
};

const createAndSelectSession = async () => {
  if (state.currentSessionId) {
    await apiFetch(`/sessions/${encodeURIComponent(state.currentSessionId)}/checkpoint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'new_session' }),
    });
  }

  const sessionId = createSessionId();
  await apiFetch('/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, source: { kind: 'web', interactive: true }, metadata: {} }),
  });
  await refreshSessions();
  await selectSession(sessionId);
};

// ─── Composer ───────────────────────────────────────────────────────────────

composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = composerInput.value.trim();
  if (!text || !state.currentSessionId) return;

  appendMessage('user', text);
  composerInput.value = '';
  state.currentAssistantBody = null;
  state.currentTurnPending = true;
  sendButton.disabled = true;
  setStatus('Running');

  try {
    const response = await apiFetch(
      `/sessions/${encodeURIComponent(state.currentSessionId)}/messages`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) },
    );
    if (!response.ok) throw new Error(`Failed to post message (${response.status})`);
    await refreshSessions();
  } catch (error) {
    state.currentTurnPending = false;
    sendButton.disabled = false;
    setStatus('Idle');
    appendEvent(`[error] ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
});

composerInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  if (sendButton.disabled) return;
  composer.requestSubmit();
});

newSessionButton.addEventListener('click', () => void createAndSelectSession());

// ─── Connect / disconnect ───────────────────────────────────────────────────

const showChat = () => {
  connectScreen.hidden = true;
  chatShell.hidden = false;
};

const showConnect = () => {
  connectScreen.hidden = false;
  chatShell.hidden = true;
  if (state.eventSource) { state.eventSource.close(); state.eventSource = null; }
  state.sessions = [];
  state.currentSessionId = null;
  state.currentEventId = 0;
  state.currentAssistantBody = null;
  state.currentTurnPending = false;
};

const startChat = async (conn) => {
  setConnection(conn);
  agentMeta.textContent = `Agent: ${conn.agentId} · ${conn.gatewayUrl}`;

  // Verify connectivity before switching screens.
  await refreshSessions();
  showChat();

  if (state.sessions.length > 0) {
    await selectSession(state.sessions[0].sessionId);
  } else {
    await createAndSelectSession();
  }
};

connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  connectError.textContent = '';
  connectButton.disabled = true;
  connectButton.textContent = 'Connecting...';

  const conn = {
    gatewayUrl: connectGatewayUrl.value.trim().replace(/\/+$/, ''),
    agentId: connectAgentId.value.trim(),
    token: connectToken.value.trim(),
  };

  try {
    // Validate by hitting the agent health endpoint.
    setConnection(conn);
    const response = await apiFetch('/health');
    if (!response.ok) throw new Error(`Agent health check failed (${response.status})`);

    saveConnection(conn);
    await startChat(conn);
  } catch (error) {
    // If we already switched to chat, show error there; otherwise on connect screen.
    const msg = error instanceof Error ? error.message : String(error);
    if (chatShell.hidden) {
      connectError.textContent = msg;
    } else {
      appendEvent(`[error] ${msg}`, 'error');
    }
  } finally {
    connectButton.disabled = false;
    connectButton.textContent = 'Connect';
  }
});

disconnectButton.addEventListener('click', () => {
  clearConnection();
  showConnect();
});

// ─── Init ───────────────────────────────────────────────────────────────────

const saved = loadConnection();

if (saved && saved.gatewayUrl && saved.agentId) {
  // Pre-fill the form in case the connection fails.
  connectGatewayUrl.value = saved.gatewayUrl;
  connectAgentId.value = saved.agentId;
  connectToken.value = saved.token || '';

  startChat(saved).catch((error) => {
    showConnect();
    connectError.textContent = error instanceof Error ? error.message : String(error);
  });
} else {
  // Pre-fill with defaults.
  connectGatewayUrl.value = window.location.origin;
  connectAgentId.value = 'one';
  showConnect();
}
