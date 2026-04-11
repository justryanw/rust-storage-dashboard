// ── Hidden debug menu ─────────────────────────────────────────────────────────
// Trigger: click the page header <h1> five times within 3 seconds.

(function () {
  let _clickCount = 0;
  let _clickTimer = null;
  let _debugOpen = false;
  let _allItemsEnabled = false;
  let _fakeInventory = null;
  let _shortnamesEnabled = false;

  // ── Trigger detection ──────────────────────────────────────────────────────
  // Scripts are at bottom of <body> so DOM is already ready — attach directly.
  const _h1 = document.querySelector('header h1');
  if (_h1) {
    _h1.addEventListener('click', () => {
      _clickCount++;
      clearTimeout(_clickTimer);
      _clickTimer = setTimeout(() => { _clickCount = 0; }, 3000);
      if (_clickCount >= 5) {
        _clickCount = 0;
        clearTimeout(_clickTimer);
        toggleDebugPanel();
      }
    });
  }

  // ── Debug inventory builder ────────────────────────────────────────────────
  // Returns a transformed inventory based on active debug flags.
  function _debugInventory(real) {
    let inv = (_allItemsEnabled && _fakeInventory) ? _fakeInventory : real;
    if (_shortnamesEnabled) {
      const mapped = {};
      for (const [k, item] of Object.entries(inv)) {
        mapped[k] = { ...item, name: item.shortname || item.name };
      }
      inv = mapped;
    }
    return inv;
  }

  function _isDebugActive() {
    return _allItemsEnabled || _shortnamesEnabled;
  }

  // ── Intercept render() ─────────────────────────────────────────────────────
  window.addEventListener('load', () => {
    const _origRender = window.render;
    window.render = function () {
      if (_isDebugActive()) {
        const real = state.inventory;
        state.inventory = _debugInventory(real);
        _origRender();
        state.inventory = real;
      } else {
        _origRender();
      }
    };

    const _origRenderInventory = window.renderInventory;
    window.renderInventory = function () {
      if (_isDebugActive()) {
        const real = state.inventory;
        state.inventory = _debugInventory(real);
        _origRenderInventory();
        state.inventory = real;
      } else {
        _origRenderInventory();
      }
    };
  });

  // ── Panel ──────────────────────────────────────────────────────────────────
  function toggleDebugPanel() {
    if (_debugOpen) {
      const panel = document.getElementById('debugPanel');
      if (panel) panel.remove();
      _debugOpen = false;
    } else {
      openDebugPanel();
    }
  }

  function openDebugPanel() {
    _debugOpen = true;
    const panel = document.createElement('div');
    panel.id = 'debugPanel';
    panel.style.cssText = [
      'position:fixed', 'bottom:16px', 'right:16px', 'z-index:9999',
      'background:#1a1a2e', 'border:1px solid #444', 'border-radius:8px',
      'padding:12px 16px', 'min-width:230px', 'box-shadow:0 4px 24px #0008',
      'font-family:monospace', 'font-size:0.82rem', 'color:#ccc',
    ].join(';');

    const btnStyle = `background:#2a2a4a;border:1px solid #555;border-radius:5px;
      color:#ccc;cursor:pointer;padding:6px 10px;text-align:left;
      font-family:monospace;font-size:0.82rem;width:100%`;

    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span style="color:#7c7cff;font-weight:700;letter-spacing:0.05em">DEBUG</span>
        <button id="debugCloseBtn" style="background:none;border:none;color:#888;cursor:pointer;font-size:1rem;padding:0 2px">✕</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button id="debugAllItemsBtn" style="${btnStyle}">
          Show all items (1 each): <span id="debugAllItemsState" style="color:#f87">OFF</span>
        </button>
        <button id="debugShortNamesBtn" style="${btnStyle}">
          Show internal names: <span id="debugShortNamesState" style="color:#f87">OFF</span>
        </button>
        <button id="debugCopyMiscBtn" style="${btnStyle}">
          Copy misc shortnames
        </button>
      </div>`;

    document.body.appendChild(panel);

    document.getElementById('debugCloseBtn').addEventListener('click', toggleDebugPanel);
    document.getElementById('debugAllItemsBtn').addEventListener('click', toggleAllItems);
    document.getElementById('debugShortNamesBtn').addEventListener('click', toggleShortnames);
    document.getElementById('debugCopyMiscBtn').addEventListener('click', copyMiscShortnames);
    _updateButtons();
  }

  // ── All-items toggle ───────────────────────────────────────────────────────
  async function toggleAllItems() {
    if (!_allItemsEnabled && !_fakeInventory) {
      try {
        const items = await (await fetch('/api/items')).json();
        const fakeInv = {};
        for (const item of items) {
          if (!item.itemId || !item.name) continue;
          fakeInv[String(item.itemId)] = {
            itemId: item.itemId,
            name: item.name,
            shortname: item.shortname || null,
            quantity: 1,
            sources: [],
          };
        }
        _fakeInventory = fakeInv;
      } catch (e) {
        console.error('[debug] Failed to fetch items:', e);
        return;
      }
    }
    _allItemsEnabled = !_allItemsEnabled;
    renderInventory();
    _updateButtons();
  }

  // ── Shortnames toggle ──────────────────────────────────────────────────────
  function toggleShortnames() {
    _shortnamesEnabled = !_shortnamesEnabled;
    renderInventory();
    _updateButtons();
  }

  // ── Copy misc shortnames ───────────────────────────────────────────────────
  function copyMiscShortnames() {
    const inv = _debugInventory(state.inventory);
    const shortnames = Object.values(inv)
      .filter(item => item.shortname && getItemCategories(item.shortname).join() === 'misc')
      .map(item => item.shortname)
      .sort();

    if (shortnames.length === 0) {
      const btn = document.getElementById('debugCopyMiscBtn');
      if (btn) { btn.textContent = 'Nothing in misc'; setTimeout(() => { btn.textContent = 'Copy misc shortnames'; }, 2000); }
      return;
    }

    navigator.clipboard.writeText(shortnames.join('\n')).then(() => {
      const btn = document.getElementById('debugCopyMiscBtn');
      if (btn) { btn.textContent = `Copied ${shortnames.length} shortnames`; setTimeout(() => { btn.textContent = 'Copy misc shortnames'; }, 2000); }
    });
  }

  // ── Button state ───────────────────────────────────────────────────────────
  function _updateButtons() {
    _setBtn('debugAllItemsState', _allItemsEnabled);
    _setBtn('debugShortNamesState', _shortnamesEnabled);
  }

  function _setBtn(id, on) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = on ? 'ON' : 'OFF';
    el.style.color = on ? '#7f7' : '#f87';
  }
})();
