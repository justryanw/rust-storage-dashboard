// ── Poll bar ──────────────────────────────────────────────────────────────────
function animatePollBar() {
  const btn = document.getElementById('refreshBtn');
  if (!pollBarStart || state.status !== 'connected') {
    btn.style.background = '';
    return;
  }
  const elapsed = Date.now() - pollBarStart;
  const pct = Math.min((elapsed / POLL_INTERVAL) * 100, 100);
  btn.style.background = `conic-gradient(var(--accent) ${pct}%, var(--surface2) ${pct}%)`;
  if (pct < 100) requestAnimationFrame(animatePollBar);
}

function resetPollBar() {
  pollBarStart = Date.now();
  requestAnimationFrame(animatePollBar);
  // Restart bar locally every poll interval so it doesn't stick at 100%
  // while waiting for the server to respond
  clearTimeout(resetPollBar._timer);
  resetPollBar._timer = setTimeout(() => {
    if (state.status === 'connected') resetPollBar();
  }, POLL_INTERVAL);
}

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
        resetPollBar();
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

async function loadConfig() {
  try {
    const cfg = await api('GET', '/api/config');
    document.getElementById('cfgIp').value = cfg.serverIp || '';
    document.getElementById('cfgPort').value = cfg.appPort || 28082;
    document.getElementById('cfgSteamId').value = cfg.steamId || '';
    document.getElementById('cfgToken').value = cfg.playerToken || '';
    document.getElementById('cfgGcmId').value = cfg.gcmAndroidId || '';
    document.getElementById('cfgGcmToken').value = cfg.gcmSecurityToken || '';

    // Pre-populate promptedIds so existing monitors don't trigger the naming modal on load
    (cfg.entityIds || []).forEach(id => promptedIds.add(String(id)));
    monitorsInitialized = true;
  } catch (e) {
    console.error('Failed to load config:', e.message);
    showBanner('Failed to load configuration from server.');
  }
}
