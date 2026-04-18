// ── State ──────────────────────────────────────────────────────────────────

let token = sessionStorage.getItem('adminToken') ?? '';
let currentTab = 'agents';
let logTimer = null;
let statsTimer = null;

// ── DOM refs ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const authScreen = $('auth-screen');
const authForm = $('auth-form');
const authError = $('auth-error');
const authToken = $('auth-token');

const shell = $('shell');
const tabs = document.querySelectorAll('.tab');

const agentList = $('agent-list');
const createAgentBtn = $('create-agent-btn');
const createAgentDialog = $('create-agent-dialog');
const createAgentForm = $('create-agent-form');
const cancelCreate = $('cancel-create');

const secretsDialog = $('secrets-dialog');
const secretsAgentId = $('secrets-agent-id');
const secretsList = $('secrets-list');
const secretsError = $('secrets-error');

const configDialog = $('config-dialog');
const configAgentId = $('config-agent-id');
const configEditor = $('config-editor');
const configError = $('config-error');
const saveConfig = $('save-config');
const cancelConfig = $('cancel-config');

const statsGrid = $('stats-grid');
const logView = $('log-view');
const logsAutoRefresh = $('logs-auto-refresh');

// ── API helper ─────────────────────────────────────────────────────────────

const api = async (path, { method = 'GET', body } = {}) => {
  const init = {
    method,
    headers: { authorization: `Bearer ${token}` },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
};

// ── Auth ───────────────────────────────────────────────────────────────────

const showAuth = () => {
  authScreen.hidden = false;
  shell.hidden = true;
  stopTimers();
};

const showShell = () => {
  authScreen.hidden = true;
  shell.hidden = false;
  switchTab(currentTab);
};

const tryAuth = async () => {
  // Verify admin access
  await api('/admin/stats');
};

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = authForm.querySelector('button[type="submit"]');
  token = authToken.value.trim();
  authError.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    await tryAuth();
    sessionStorage.setItem('adminToken', token);
    showShell();
  } catch (err) {
    authError.textContent = `Authentication failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

$('sign-out').addEventListener('click', () => {
  token = '';
  sessionStorage.removeItem('adminToken');
  showAuth();
});

// ── Tabs ───────────────────────────────────────────────────────────────────

const switchTab = (tab) => {
  currentTab = tab;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.panel').forEach((p) => {
    p.hidden = p.id !== `panel-${tab}`;
  });
  stopTimers();

  if (tab === 'agents') loadAgents();
  if (tab === 'stats') { loadStats(); statsTimer = setInterval(loadStats, 10_000); }
  if (tab === 'logs') { loadLogs(); startLogPolling(); }
};

tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

const stopTimers = () => {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
};

// ── Agents ─────────────────────────────────────────────────────────────────

const loadAgents = async () => {
  try {
    const agents = await api('/agents');
    renderAgents(agents);
  } catch (err) {
    agentList.innerHTML = `<p class="agent-list__empty">${err.message}</p>`;
  }
};

const renderAgents = (agents) => {
  if (agents.length === 0) {
    agentList.innerHTML = '<p class="agent-list__empty">No agents yet. Create one to get started.</p>';
    return;
  }
  agentList.innerHTML = agents.map((a) => `
    <div class="agent-card" data-agent-id="${esc(a.agentId)}">
      <div class="agent-card__info">
        <span class="agent-card__id">${esc(a.agentId)}</span>
        ${a.name ? `<span class="agent-card__name">${esc(a.name)}</span>` : ''}
        <span class="badge badge--${a.status}">${a.status}</span>
        <div class="agent-card__dirs">${esc(a.configDir)}</div>
      </div>
      <div class="agent-card__actions">
        ${a.status === 'stopped'
          ? `<button class="btn btn--sm" data-action="start">Start</button>`
          : `<button class="btn btn--sm" data-action="stop">Stop</button>
             <button class="btn btn--sm" data-action="restart">Restart</button>
             <button class="btn btn--sm" data-action="config">Config</button>
             <button class="btn btn--sm" data-action="secrets">Secrets</button>`
        }
      </div>
    </div>
  `).join('');

  // Bind action buttons
  agentList.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.agent-card');
      const agentId = card.dataset.agentId;
      const action = btn.dataset.action;

      if (action === 'config') {
        openConfig(agentId);
        return;
      }

      if (action === 'secrets') {
        openSecrets(agentId);
        return;
      }

      btn.disabled = true;
      btn.textContent = action === 'start' ? 'Starting...' : action === 'stop' ? 'Stopping...' : 'Restarting...';
      try {
        await api(`/agents/${encodeURIComponent(agentId)}/manage/${action}`, { method: 'POST' });
      } catch (err) {
        alert(`Failed to ${action} ${agentId}: ${err.message}`);
      }
      await loadAgents();
    });
  });
};

// ── Create agent ───────────────────────────────────────────────────────────

createAgentBtn.addEventListener('click', () => {
  $('new-agent-id').value = '';
  $('new-agent-name').value = '';
  createAgentDialog.showModal();
});

cancelCreate.addEventListener('click', () => createAgentDialog.close());

createAgentForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const agentId = $('new-agent-id').value.trim();
  const name = $('new-agent-name').value.trim();
  if (!agentId) return;

  try {
    await api('/agents', {
      method: 'POST',
      body: { agentId, ...(name ? { name } : {}) },
    });
    createAgentDialog.close();
    await loadAgents();
  } catch (err) {
    alert(`Failed to create agent: ${err.message}`);
  }
});

// ── Secrets editor ─────────────────────────────────────────────────────────

let currentSecrets = {};

const renderSecrets = () => {
  const keys = Object.keys(currentSecrets).sort();
  if (keys.length === 0) {
    secretsList.innerHTML = '<p class="secrets-empty">No secrets configured.</p>';
    return;
  }
  secretsList.innerHTML = keys.map((k) => `
    <div class="secret-row" data-key="${esc(k)}">
      <span class="secret-row__key">${esc(k)}</span>
      <input class="secret-row__value" type="text" value="${esc(currentSecrets[k])}" data-secret-key="${esc(k)}" />
      <button class="btn btn--sm btn--danger" data-delete="${esc(k)}">Delete</button>
    </div>
  `).join('');

  // Bind value changes
  secretsList.querySelectorAll('.secret-row__value').forEach((input) => {
    input.addEventListener('input', () => {
      currentSecrets[input.dataset.secretKey] = input.value;
    });
  });

  // Bind delete buttons
  secretsList.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      delete currentSecrets[btn.dataset.delete];
      renderSecrets();
    });
  });
};

const openSecrets = async (agentId) => {
  secretsAgentId.textContent = agentId;
  secretsError.textContent = '';
  secretsList.innerHTML = '<p class="secrets-empty">Loading...</p>';
  $('new-secret-key').value = '';
  $('new-secret-value').value = '';
  secretsDialog.showModal();

  try {
    currentSecrets = await api(`/admin/agents/${encodeURIComponent(agentId)}/secrets`);
    renderSecrets();
  } catch (err) {
    secretsList.innerHTML = '';
    secretsError.textContent = err.message;
  }
};

$('add-secret-btn').addEventListener('click', () => {
  const keyInput = $('new-secret-key');
  const valInput = $('new-secret-value');
  const key = keyInput.value.trim();
  const val = valInput.value;
  if (!key) return;
  currentSecrets[key] = val;
  keyInput.value = '';
  valInput.value = '';
  renderSecrets();
});

$('save-secrets').addEventListener('click', async () => {
  const agentId = secretsAgentId.textContent;
  secretsError.textContent = '';
  try {
    await api(`/admin/agents/${encodeURIComponent(agentId)}/secrets`, {
      method: 'PUT',
      body: currentSecrets,
    });
    secretsDialog.close();
  } catch (err) {
    secretsError.textContent = err.message;
  }
});

$('cancel-secrets').addEventListener('click', () => secretsDialog.close());

// ── Config editor ──────────────────────────────────────────────────────────

const openConfig = async (agentId) => {
  configAgentId.textContent = agentId;
  configError.textContent = '';
  configEditor.value = 'Loading...';
  configDialog.showModal();

  try {
    const config = await api(`/admin/agents/${encodeURIComponent(agentId)}/config`);
    configEditor.value = JSON.stringify(config, null, 2);
  } catch (err) {
    configEditor.value = '';
    configError.textContent = err.message;
  }
};

saveConfig.addEventListener('click', async () => {
  const agentId = configAgentId.textContent;
  configError.textContent = '';

  let parsed;
  try {
    parsed = JSON.parse(configEditor.value);
  } catch {
    configError.textContent = 'Invalid JSON.';
    return;
  }

  try {
    await api(`/admin/agents/${encodeURIComponent(agentId)}/config`, {
      method: 'PUT',
      body: parsed,
    });
    configDialog.close();
  } catch (err) {
    configError.textContent = err.message;
  }
});

cancelConfig.addEventListener('click', () => configDialog.close());

// ── Stats ──────────────────────────────────────────────────────────────────

const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatUptime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const loadStats = async () => {
  try {
    const stats = await api('/admin/stats');
    const c = stats.counts ?? {};
    statsGrid.innerHTML = [
      { label: 'Uptime', value: formatUptime(stats.uptime) },
      { label: 'Running Agents', value: stats.agents.running },
      { label: 'Users', value: c.users ?? 0 },
      { label: 'Sessions', value: c.sessions ?? 0 },
      { label: 'Session Events', value: c.sessionEvents ?? 0 },
      { label: 'RSS Memory', value: formatBytes(stats.memory.rss) },
      { label: 'Heap Used', value: formatBytes(stats.memory.heapUsed) },
      { label: 'Heap Total', value: formatBytes(stats.memory.heapTotal) },
    ].map((s) => `
      <div class="stat-card">
        <div class="stat-card__label">${s.label}</div>
        <div class="stat-card__value">${s.value}</div>
      </div>
    `).join('');
  } catch (err) {
    statsGrid.innerHTML = `<p>${err.message}</p>`;
  }
};

// ── Logs ───────────────────────────────────────────────────────────────────

const loadLogs = async () => {
  try {
    const entries = await api('/admin/logs?lines=500');
    logView.innerHTML = entries.map((e) =>
      `<span class="ts">${e.timestamp.slice(11, 23)}</span> ${esc(e.message)}`
    ).join('\n');
    logView.scrollTop = logView.scrollHeight;
  } catch (err) {
    logView.textContent = err.message;
  }
};

const startLogPolling = () => {
  if (logsAutoRefresh.checked) {
    logTimer = setInterval(loadLogs, 3_000);
  }
};

logsAutoRefresh.addEventListener('change', () => {
  if (logTimer) { clearInterval(logTimer); logTimer = null; }
  if (logsAutoRefresh.checked) startLogPolling();
});

// ── Utils ──────────────────────────────────────────────────────────────────

const esc = (s) => {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
};

// ── Init ───────────────────────────────────────────────────────────────────

(async () => {
  if (token) {
    try {
      await tryAuth();
      showShell();
      return;
    } catch {
      // Stored token is stale — fall through to auth screen
      sessionStorage.removeItem('adminToken');
      token = '';
    }
  }
  showAuth();
})();
