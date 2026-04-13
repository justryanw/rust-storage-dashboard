function flashReconnectDot() {
  const dot = document.querySelector('#statusBadge .status-dot');
  if (dot) {
    dot.classList.remove('flash');
    void dot.offsetWidth;
    dot.classList.add('flash');
    dot.addEventListener('animationend', () => dot.classList.remove('flash'), { once: true });
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.onmessage = (e) => {
    try {
      const newState = JSON.parse(e.data);
      state = newState;
      render();
      if (state.status === 'connected') {
        hasBeenConnected = true;
        clearTimeout(autoReconnectTimer);
      } else if (state.status === 'disconnected') {
        scheduleAutoReconnect();
      }
    } catch (_) {}
  };

  ws.onclose = () => {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

function scheduleAutoReconnect() {
  clearTimeout(autoReconnectTimer);
  const cfg = state.config || {};
  if (!cfg.serverIp || !cfg.appPort || !cfg.steamId || !cfg.playerToken) return;
  autoReconnectTimer = setTimeout(() => {
    if (state.status === 'disconnected') {
      flashReconnectDot();
      api('POST', '/api/connect').catch(() => {});
    }
  }, RECONNECT_INTERVAL);
}

// ── API helpers ───────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function apiRefresh() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  try {
    await api('POST', '/api/refresh');
  } catch (e) {
    console.error('Refresh failed:', e.message);
  } finally {
    btn.disabled = state.status !== 'connected';
  }
}

async function saveConfig() {
  const token = document.getElementById('cfgToken').value;
  const gcmId = document.getElementById('cfgGcmId').value.trim();
  const gcmTok = document.getElementById('cfgGcmToken').value.trim();
  const body = {
    serverIp: document.getElementById('cfgIp').value.trim(),
    appPort: parseInt(document.getElementById('cfgPort').value) || 28082,
    steamId: document.getElementById('cfgSteamId').value.trim(),
    gcmAndroidId: gcmId,
  };
  if (!token.includes('•')) body.playerToken = token;
  if (!gcmTok.includes('•')) body.gcmSecurityToken = gcmTok;
  const res = await api('POST', '/api/config', body);
  if (res.success) closeConfigModal();
}

function exportEntityIds() {
  const ids = (state.config || {}).entityIds || [];
  navigator.clipboard.writeText(JSON.stringify(ids)).then(() => {
    alert(`Copied ${ids.length} entity ID${ids.length !== 1 ? 's' : ''} to clipboard.`);
  });
}

async function importEntityIds() {
  try {
    const text = await navigator.clipboard.readText();
    const ids = JSON.parse(text);
    if (!Array.isArray(ids) || !ids.every(id => Number.isInteger(Number(id)))) {
      alert('Clipboard must contain a JSON array of entity IDs.');
      return;
    }
    const existing = (state.config || {}).entityIds || [];
    const merged = [...new Set([...existing.map(String), ...ids.map(String)])];
    await api('POST', '/api/config', { entityIds: merged.map(Number) });
    alert(`Imported ${merged.length - existing.length} new entity ID${merged.length - existing.length !== 1 ? 's' : ''}.`);
  } catch (e) {
    alert('Failed to import: ' + e.message);
  }
}

async function loadConfig() {
  try {
    const [cfg, initialState] = await Promise.all([
      api('GET', '/api/config'),
      api('GET', '/api/state'),
    ]);

    document.getElementById('cfgIp').value = cfg.serverIp || '';
    document.getElementById('cfgPort').value = cfg.appPort || 28082;
    document.getElementById('cfgSteamId').value = cfg.steamId || '';
    document.getElementById('cfgToken').value = cfg.playerToken || '';
    document.getElementById('cfgGcmId').value = cfg.gcmAndroidId || '';
    document.getElementById('cfgGcmToken').value = cfg.gcmSecurityToken || '';

    // Render actual server state immediately so the page doesn't flash "Disconnected"
    // while the WebSocket is still being established
    state = initialState;
    render();

    // Pre-populate promptedIds so existing monitors don't trigger the naming modal on load
    (cfg.entityIds || []).forEach(id => promptedIds.add(String(id)));
    monitorsInitialized = true;
  } catch (e) {
    console.error('Failed to load config:', e.message);
    showBanner('Failed to load configuration from server.');
  }
}
