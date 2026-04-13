// ── Hidden groups ─────────────────────────────────────────────────────────────
const _hiddenGroups = new Set(JSON.parse(localStorage.getItem('hiddenGroups') || '[]'));
const _slotHiddenGroups = new Set(JSON.parse(localStorage.getItem('slotHiddenGroups') || '[]'));

function toggleGroupVisibility(name) {
  if (_hiddenGroups.has(name)) _hiddenGroups.delete(name);
  else _hiddenGroups.add(name);
  localStorage.setItem('hiddenGroups', JSON.stringify([..._hiddenGroups]));
  renderInventory();
  renderGroups();
  renderStats();
}

function isGroupHidden(name) {
  return _hiddenGroups.has(name);
}

function toggleGroupSlotVisibility(name) {
  if (_slotHiddenGroups.has(name)) _slotHiddenGroups.delete(name);
  else _slotHiddenGroups.add(name);
  localStorage.setItem('slotHiddenGroups', JSON.stringify([..._slotHiddenGroups]));
  renderGroups();
  renderStats();
}

function isGroupSlotHidden(name) {
  return _slotHiddenGroups.has(name);
}

function getVisibleInventory() {
  if (_hiddenGroups.size === 0) return state.inventory;
  const entityGroups = (state.config || {}).entityGroups || {};
  const monitors = state.monitors || {};
  const result = {};
  for (const [key, item] of Object.entries(state.inventory || {})) {
    let visibleQty = 0;
    const visibleSources = [];
    for (const sourceId of (item.sources || [])) {
      const groupName = entityGroups[String(sourceId)];
      if (groupName && _hiddenGroups.has(groupName)) continue;
      const m = monitors[sourceId];
      const qty = (m?.items || []).filter(i => i.itemId === item.itemId).reduce((s, i) => s + i.quantity, 0);
      visibleQty += qty;
      visibleSources.push(sourceId);
    }
    if (visibleQty > 0) result[key] = { ...item, quantity: visibleQty, sources: visibleSources };
  }
  return result;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 1) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function refreshTimestamps() {
  document.querySelectorAll('.monitor-updated[data-updated]').forEach(el => {
    el.textContent = timeAgo(el.dataset.updated);
  });
}

function fmtDuration(seconds) {
  if (seconds <= 0) return 'Expired';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function upkeepColor(seconds) {
  if (seconds <= 0) return 'var(--red)';
  if (seconds < 3600) return 'var(--red)';
  if (seconds < 86400) return 'var(--yellow)';
  return 'var(--green)';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getInvItem(itemId) {
  return Object.values(state.inventory || {}).find(i => i.itemId === itemId) || null;
}

function getItemName(itemId) {
  return getInvItem(itemId)?.name || `Item #${itemId}`;
}

function getItemShortname(itemId) {
  return getInvItem(itemId)?.shortname || null;
}

function isAutoReconnecting() {
  const cfg = state.config || {};
  const hasConfig = cfg.serverIp && cfg.appPort && cfg.steamId && cfg.playerToken;
  return hasConfig && (
    state.status === 'disconnected' ||
    (hasBeenConnected && (state.status === 'connecting' || state.status === 'error'))
  );
}

function itemIconHTML(shortname, size = 36) {
  if (!shortname) return '';
  return `<img class="item-icon" src="https://wiki.rustclash.com/img/items180/${escHtml(shortname)}.png" width="${size}" height="${size}" alt="" loading="lazy" onerror="this.style.display='none'" />`;
}

function itemSlotInfo(item) {
  const monitors = state.monitors || {};
  let slots = 0;
  for (const id of (item.sources || [])) {
    const m = monitors[String(id)];
    if (m) slots += (m.items || []).filter(i => i.itemId === item.itemId).length;
  }
  const maxStack = getMaxStack(item.shortname);
  const minSlots = maxStack ? Math.ceil(item.quantity / maxStack) : null;
  const efficiency = (maxStack && slots > 0) ? Math.round((minSlots / slots) * 100) : null;
  return { slots, maxStack, minSlots, efficiency };
}

// ── Card HTML generators ──────────────────────────────────────────────────────
function itemCardHTML(item) {
  const si = itemSlotInfo(item);
  const effColor = si.efficiency === null ? 'var(--text-muted)'
    : si.efficiency >= 80 ? 'var(--green)'
    : si.efficiency >= 50 ? 'var(--yellow)'
    : 'var(--red)';
  const effText = si.efficiency !== null ? `${si.efficiency}%` : '';
  const wastedSlots = si.minSlots !== null ? si.slots - si.minSlots : 0;
  return `
    <div class="item-card" style="cursor:pointer" onclick="showItemModal(${item.itemId})" title="Click to see all locations">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        ${itemIconHTML(item.shortname)}
        <div style="min-width:0;flex:1">
          <div class="item-name">${escHtml(item.name)}</div>
          <div class="item-qty">${fmt(item.quantity)}</div>
        </div>
      </div>
      ${item.isBlueprint ? '<div style="margin-bottom:4px"><span class="item-bp">BP</span></div>' : ''}
      <div class="item-slot-info">
        <span style="color:var(--text-muted)">${si.slots} slot${si.slots !== 1 ? 's' : ''}${wastedSlots > 0 ? ` <span style="color:var(--red);font-size:0.7rem">(-${wastedSlots})</span>` : ''}</span>
        ${effText ? `<span style="font-weight:700;color:${effColor}">${effText}</span>` : ''}
      </div>
    </div>`;
}

function tableRowHTML(item) {
  const si = itemSlotInfo(item);
  const effColor = si.efficiency === null ? 'var(--text-muted)'
    : si.efficiency >= 80 ? 'var(--green)'
    : si.efficiency >= 50 ? 'var(--yellow)'
    : 'var(--red)';
  const effText = si.efficiency !== null ? `${si.efficiency}%` : '—';
  return `
    <tr style="cursor:pointer" onclick="showItemModal(${item.itemId})" title="Click to see all locations">
      <td style="display:flex;align-items:center;gap:8px">${itemIconHTML(item.shortname, 24)}${escHtml(item.name)}${item.isBlueprint ? ' <span class="item-bp">BP</span>' : ''}</td>
      <td class="qty-cell">${item.quantity.toLocaleString()}</td>
      <td class="qty-cell">${si.slots}</td>
      <td class="qty-cell" style="color:${effColor};font-weight:700">${effText}</td>
    </tr>`;
}

function monitorCardHTML(m, query = '', cardId = `mc-${m.entityId}`) {
  const usedSlots = (m.items || []).length;
  const cap = m.capacity || 0;
  const pct = cap ? Math.round((usedSlots / cap) * 100) : 0;
  const isRemoved = m.error === 'not_found';
  const isUnpowered = m.unpowered;
  const groupName = ((state.config || {}).entityGroups || {})[String(m.entityId)] || null;
  const statusBadge = isRemoved
    ? `<span style="font-size:0.72rem;background:#3b0f0f;color:var(--red);border:1px solid #7f1d1d;border-radius:4px;padding:1px 6px">No Response</span>`
    : isUnpowered
    ? `<span style="font-size:0.72rem;background:#2a1f00;color:var(--yellow);border:1px solid #78580a;border-radius:4px;padding:1px 6px">Unpowered</span>`
    : m.error
    ? `<span class="monitor-error">⚠ ${escHtml(m.error)}</span>`
    : `<span class="monitor-capacity">${usedSlots}/${cap} slots (${pct}%)</span>`;
  const mergedItems = {};
  for (const item of (m.items || [])) {
    const key = String(item.itemId);
    if (!mergedItems[key]) mergedItems[key] = { itemId: item.itemId, quantity: 0 };
    mergedItems[key].quantity += item.quantity;
  }
  const itemsHTML = query ? Object.values(mergedItems)
    .filter(item => getItemName(item.itemId).toLowerCase().includes(query) || String(item.itemId).includes(query))
    .sort((a, b) => b.quantity - a.quantity)
    .map(item => `
      <div class="monitor-item">
        ${itemIconHTML(getItemShortname(item.itemId), 24)}
        <span class="monitor-item-name">${escHtml(getItemName(item.itemId))}</span>
        <span class="monitor-item-qty">${item.quantity.toLocaleString()}</span>
      </div>`).join('') : '';
  return `
    <div class="monitor-card" id="${cardId}" ${isRemoved ? 'style="opacity:0.5"' : ''} onclick="showMonitorModal('${m.entityId}')">
      <div class="monitor-header">
        <div class="monitor-header-top">
          <span class="monitor-name">${escHtml(m.label || m.entityId)}</span>
        </div>
        <div class="monitor-header-meta">
          ${groupName ? `<span class="monitor-group-tag">${escHtml(groupName)}</span>` : ''}
          ${statusBadge}
          ${m.lastUpdated ? `<span class="monitor-updated" data-updated="${m.lastUpdated}">${timeAgo(m.lastUpdated)}</span>` : ''}
        </div>
      </div>
      ${query && !m.error && !isUnpowered && cap ? `<div class="capacity-bar-wrap"><div class="capacity-bar"><div class="capacity-fill" style="width:${pct}%"></div></div></div>` : ''}
      ${query ? `<div class="monitor-items" onclick="event.stopPropagation()">${itemsHTML || '<div style="color:var(--text-muted);font-size:0.82rem;padding:4px 0">No matches</div>'}</div>` : ''}
    </div>`;
}

// ── DOM diffing helpers ───────────────────────────────────────────────────────
const cardCache = {};

function updateGrid(grid, cards) {
  const newMap = new Map(cards.map(c => [c.id, c.html]));

  // Remove cards no longer present
  [...grid.children].forEach(el => {
    if (!newMap.has(el.id)) { delete cardCache[el.id]; el.remove(); }
  });

  cards.forEach((card, i) => {
    let el = document.getElementById(card.id);
    if (el) {
      // Compare against last generated HTML (not browser-normalized outerHTML)
      // so unchanged data never triggers DOM mutations
      if (cardCache[card.id] !== card.html) {
        cardCache[card.id] = card.html;
        const tmp = document.createElement('div');
        tmp.innerHTML = card.html;
        const newEl = tmp.firstElementChild;
        // Patch outer element class (e.g. hidden state)
        if (el.className !== newEl.className) el.className = newEl.className;
        // Patch header for status badge / name changes
        const oldHeader = el.querySelector('.monitor-header, .group-header');
        const newHeader = newEl.querySelector('.monitor-header, .group-header');
        if (oldHeader && newHeader && oldHeader.innerHTML !== newHeader.innerHTML) {
          oldHeader.innerHTML = newHeader.innerHTML;
        }
        // Patch item lists and capacity bar (only present when searching)
        for (const sel of ['.monitor-items', '.group-items']) {
          const a = el.querySelector(sel), b = newEl.querySelector(sel);
          if (a && b && a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML;
          else if (a && !b) a.remove();
          else if (!a && b) el.appendChild(b);
        }
        const oldBar = el.querySelector('.capacity-bar-wrap');
        const newBar = newEl.querySelector('.capacity-bar-wrap');
        if ((oldBar?.outerHTML || '') !== (newBar?.outerHTML || '')) {
          if (oldBar && newBar) oldBar.replaceWith(newBar);
          else if (oldBar) oldBar.remove();
          else if (newBar) el.querySelector('.monitor-header, .group-header').after(newBar);
        }
      }
    } else {
      const tmp = document.createElement('div');
      tmp.innerHTML = card.html;
      cardCache[card.id] = card.html;
      grid.insertBefore(tmp.firstElementChild, grid.children[i] || null);
    }
    // Ensure correct order
    if (grid.children[i]?.id !== card.id) {
      grid.insertBefore(document.getElementById(card.id), grid.children[i] || null);
    }
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  renderStatus();
  renderStats();
  renderInventory();
  renderGroups();
  renderMonitors();
  refreshOpenModal();
  checkNewUnlabeledMonitors();
}

function renderStatus() {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');
  const refreshBtn = document.getElementById('refreshBtn');

  const { status, error } = state;
  const reconnecting = isAutoReconnecting();
  const displayAs = reconnecting ? 'reconnecting' : status;
  badge.className = `status-badge ${displayAs}`;
  const labels = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', error: 'Error' };
  text.textContent = labels[displayAs] || status;

  refreshBtn.disabled = status !== 'connected';
  if (status !== 'connected') { refreshBtn.style.background = ''; }

  const connected = status === 'connected';
  document.getElementById('statsBar').style.display = connected ? '' : 'none';
  document.getElementById('controlsBar').style.display = connected ? '' : 'none';

  showBanner(status === 'error' && error ? `Connection error: ${error}` : null);

  if (state.lastPaired && state.lastPaired.timestamp !== lastHandledPairTimestamp && state.lastPaired.timestamp > sessionStart) {
    lastHandledPairTimestamp = state.lastPaired.timestamp;
    promptedIds.add(state.lastPaired.entityId);
    showPairModal(state.lastPaired);
  }
}

function checkNewUnlabeledMonitors() {
  const monitors = state.monitors || {};
  if (!monitorsInitialized) {
    Object.keys(monitors).forEach(id => promptedIds.add(id));
    monitorsInitialized = true;
    return;
  }
  const labels = (state.config || {}).entityLabels || {};
  for (const [id, monitor] of Object.entries(monitors)) {
    if (!promptedIds.has(id) && !labels[id] && monitor.error !== 'not_found') {
      promptedIds.add(id);
      monitorQueue.push({ entityId: id });
    }
  }
  if (monitorQueue.length > 0 && !pendingPairId) {
    showPairModal(monitorQueue.shift());
  }
}

function renderStats() {
  const inv = state.inventory || {};
  const items = Object.values(inv);
  const uniqueCount = items.length;
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const entityGroups = (state.config || {}).entityGroups || {};
  const monitors = Object.values(state.monitors || {}).filter(m => {
    if (m.error || m.unpowered) return false;
    const groupName = entityGroups[String(m.entityId)];
    if (groupName && (isGroupHidden(groupName) || isGroupSlotHidden(groupName))) return false;
    return true;
  });
  const monitorCount = Object.keys(state.monitors || {}).length;
  const usedSlots = monitors.reduce((s, m) => s + (m.items || []).length, 0);
  const totalSlots = monitors.reduce((s, m) => s + (m.capacity || 0), 0);

  document.getElementById('statItems').textContent = uniqueCount > 0 ? uniqueCount.toLocaleString() : '—';
  document.getElementById('statTotal').textContent = totalQty > 0 ? fmt(totalQty) : '—';
  document.getElementById('statMonitors').textContent = monitorCount > 0 ? monitorCount : '—';
  const pct = totalSlots > 0 ? Math.round((usedSlots / totalSlots) * 100) : 0;
  const remaining = totalSlots - usedSlots;
  document.getElementById('statSlotsRemaining').textContent = totalSlots > 0 ? remaining.toLocaleString() : '—';
  document.getElementById('statSlotsPct').textContent = totalSlots > 0 ? `${100 - pct}% free` : '';
  document.getElementById('statSlotsSub').textContent = totalSlots > 0 ? `${usedSlots.toLocaleString()} used of ${totalSlots.toLocaleString()} total` : '';
  document.getElementById('statSlotsBar').style.width = `${pct}%`;

  if (state.lastUpdate) {
    const d = new Date(state.lastUpdate);
    document.getElementById('statTime').textContent = d.toLocaleTimeString();
    document.getElementById('statDate').textContent = d.toLocaleDateString();
    document.getElementById('lastUpdateLabel').textContent = `Updated ${d.toLocaleTimeString()}`;
  }

  // Upkeep card — find the earliest protectionExpiry across all monitors
  const now = Math.floor(Date.now() / 1000);
  const protected_ = Object.values(state.monitors || {})
    .filter(m => m.hasProtection && m.protectionExpiry > 0);
  const upkeepCard = document.getElementById('statUpkeepCard');
  if (protected_.length > 0) {
    const earliest = protected_.reduce((a, b) => a.protectionExpiry < b.protectionExpiry ? a : b);
    const remaining = earliest.protectionExpiry - now;
    const locationName = earliest.label || `#${earliest.entityId}`;
    document.getElementById('statUpkeepTime').textContent = fmtDuration(remaining);
    document.getElementById('statUpkeepTime').style.color = upkeepColor(remaining);
    document.getElementById('statUpkeepSub').textContent = locationName;
    upkeepCard.style.display = '';
  } else {
    upkeepCard.style.display = 'none';
  }
}

function getSortedItems() {
  const query = document.getElementById('searchInput').value.toLowerCase();
  const sort = document.getElementById('sortSelect').value;
  let items = Object.values(getVisibleInventory());

  if (query) items = items.filter(i => i.name.toLowerCase().includes(query) || String(i.itemId).includes(query));

  items.sort((a, b) => {
    if (sort === 'qty-desc') return b.quantity - a.quantity;
    if (sort === 'qty-asc') return a.quantity - b.quantity;
    if (sort === 'name-asc') return a.name.localeCompare(b.name);
    if (sort === 'name-desc') return b.name.localeCompare(a.name);
    if (sort === 'eff-asc' || sort === 'eff-desc') {
      const ea = itemSlotInfo(a).efficiency;
      const eb = itemSlotInfo(b).efficiency;
      if (ea === null && eb === null) return 0;
      if (ea === null) return 1;
      if (eb === null) return -1;
      return sort === 'eff-asc' ? ea - eb : eb - ea;
    }
    return 0;
  });

  return items;
}

function renderInventory() {
  const container = document.getElementById('inventoryContainer');
  if (state.status !== 'connected') {
    const reconnecting = isAutoReconnecting();
    const wantKey = reconnecting ? 'reconnecting' : 'disconnected';
    if (container.dataset.emptyState !== wantKey) {
      container.dataset.emptyState = wantKey;
      container.innerHTML = reconnecting ? `
        <div class="empty-state">
          <div class="reconnect-icon">
            <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle class="pulse-ring" cx="60" cy="60" r="55" stroke="var(--accent)" stroke-width="1.5" fill="none"/>
              <rect x="31" y="32" width="58" height="16" rx="2" fill="var(--surface2)" stroke="var(--border)" stroke-width="1.5"/>
              <rect x="31" y="52" width="58" height="16" rx="2" fill="var(--surface2)" stroke="var(--border)" stroke-width="1.5"/>
              <rect x="31" y="72" width="58" height="16" rx="2" fill="var(--surface2)" stroke="var(--border)" stroke-width="1.5"/>
              <circle cx="79" cy="40" r="3.5" fill="var(--accent)"/>
              <circle cx="79" cy="60" r="3.5" fill="var(--accent)" opacity="0.5"/>
              <circle cx="79" cy="80" r="3.5" fill="var(--text-muted)" opacity="0.4"/>
              <rect x="36" y="38" width="24" height="3" rx="1" fill="var(--text-muted)" opacity="0.5"/>
              <rect x="36" y="58" width="18" height="3" rx="1" fill="var(--text-muted)" opacity="0.5"/>
              <rect x="36" y="78" width="21" height="3" rx="1" fill="var(--text-muted)" opacity="0.5"/>
            </svg>
          </div>
          <h3>Reconnecting…</h3>
          <p>Attempting to restore connection to the server.</p>
        </div>` : `
        <div class="empty-state">
          <div class="icon">🔌</div>
          <h3>Not connected</h3>
          <p>Configure your server details to start monitoring.</p>
        </div>`;
    }
    return;
  }
  delete container.dataset.emptyState;
  const items = getSortedItems();

  if (items.length === 0) {
    const isConnected = state.status === 'connected';
    container.innerHTML = `
      <div class="empty-state">
        <div class="icon">${isConnected ? '📦' : '🔌'}</div>
        <h3>${isConnected ? 'No items found' : 'Not connected'}</h3>
        <p>${isConnected
          ? 'No storage monitors have items, or no entity IDs are configured.'
          : 'Configure your server details to start monitoring.'}
        </p>
      </div>`;
    return;
  }

  const grouped = {};
  for (const item of items) {
    for (const cat of getItemCategories(item.shortname)) {
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(item);
    }
  }
  const cats = CATEGORY_ORDER.filter(c => grouped[c]?.length);

  if (currentView === 'grid') {
    container.innerHTML = cats.map(cat => `
      <div class="category-section">
        <div class="category-header">${CATEGORY_LABELS[cat]}</div>
        <div class="inventory-grid">${grouped[cat].map(itemCardHTML).join('')}</div>
      </div>`).join('');
  } else {
    container.innerHTML = cats.map(cat => `
      <div class="category-section">
        <div class="category-header">${CATEGORY_LABELS[cat]}</div>
        <div class="table-wrap">
          <table class="inventory-table">
            <thead><tr>
              <th onclick="cycleSortTable('name')">Item <span class="sort-arrow" id="th-name"></span></th>
              <th onclick="cycleSortTable('qty-desc')">Quantity <span class="sort-arrow" id="th-qty">↓</span></th>
              <th>Slots</th>
              <th>Efficiency</th>
            </tr></thead>
            <tbody>${grouped[cat].map(tableRowHTML).join('')}</tbody>
          </table>
        </div>
      </div>`).join('');
  }
}

function cycleSortTable(col) {
  const sel = document.getElementById('sortSelect');
  if (col === 'name') {
    sel.value = sel.value === 'name-asc' ? 'name-desc' : 'name-asc';
  } else {
    sel.value = sel.value === 'qty-desc' ? 'qty-asc' : 'qty-desc';
  }
  renderInventory();
}

function renderGroups() {
  const section = document.getElementById('groupsSection');
  const grid = document.getElementById('groupsGrid');
  if (state.status !== 'connected') { section.style.display = 'none'; return; }

  const entityGroups = (state.config || {}).entityGroups || {};
  const monitors = state.monitors || {};
  const query = document.getElementById('searchInput').value.toLowerCase().trim();

  // Build group map: groupName → [monitor, ...]
  const groupMap = {};
  for (const [id, groupName] of Object.entries(entityGroups)) {
    if (!monitors[id]) continue;
    if (!groupMap[groupName]) groupMap[groupName] = [];
    groupMap[groupName].push(monitors[id]);
  }

  const groupNames = Object.keys(groupMap).filter(groupName => {
    if (!query) return true;
    return groupMap[groupName].some(m => (m.items || []).some(i =>
      getItemName(i.itemId).toLowerCase().includes(query) || String(i.itemId).includes(query)
    ));
  });

  if (groupNames.length === 0) { section.style.display = 'none'; return; }
  section.style.display = '';

  const groupCards = groupNames.map(groupName => {
    const members = groupMap[groupName];
    const mergedItems = {};
    let totalUsed = 0, totalCap = 0;
    let unpoweredCount = 0, errorCount = 0;
    for (const m of members) {
      if (m.unpowered) unpoweredCount++;
      if (m.error) errorCount++;
      totalCap += m.capacity || 0;
      totalUsed += (m.items || []).length;
      for (const item of (m.items || [])) {
        const key = String(item.itemId);
        if (!mergedItems[key]) mergedItems[key] = { itemId: item.itemId, quantity: 0 };
        mergedItems[key].quantity += item.quantity;
      }
    }
    const pct = totalCap ? Math.round((totalUsed / totalCap) * 100) : 0;
    const gid = `grp-${btoa(groupName).replace(/[^a-zA-Z0-9]/g, '')}`;
    const n = members.length;
    const statusBadge = errorCount
      ? `<span style="font-size:0.72rem;background:#3b0f0f;color:var(--red);border:1px solid #7f1d1d;border-radius:4px;padding:1px 6px">⚠ ${errorCount}/${n} Error</span>`
      : unpoweredCount
      ? `<span style="font-size:0.72rem;background:#2a1f00;color:var(--yellow);border:1px solid #78580a;border-radius:4px;padding:1px 6px">${unpoweredCount}/${n} Unpowered</span>`
      : `<span class="monitor-capacity">${totalUsed}/${totalCap} slots (${pct}%)</span>`;
    const itemsHTML = Object.values(mergedItems)
      .filter(item => !query || getItemName(item.itemId).toLowerCase().includes(query) || String(item.itemId).includes(query))
      .sort((a, b) => b.quantity - a.quantity)
      .map(item => `
        <div class="monitor-item">
          ${itemIconHTML(getItemShortname(item.itemId), 24)}
          <span class="monitor-item-name">${escHtml(getItemName(item.itemId))}</span>
          <span class="monitor-item-qty">${item.quantity.toLocaleString()}</span>
        </div>`).join('');
    const filteredItemsHTML = query ? Object.values(mergedItems)
      .filter(item => getItemName(item.itemId).toLowerCase().includes(query) || String(item.itemId).includes(query))
      .sort((a, b) => b.quantity - a.quantity)
      .map(item => `
        <div class="monitor-item">
          ${itemIconHTML(getItemShortname(item.itemId), 24)}
          <span class="monitor-item-name">${escHtml(getItemName(item.itemId))}</span>
          <span class="monitor-item-qty">${item.quantity.toLocaleString()}</span>
        </div>`).join('') : '';
    const hidden = isGroupHidden(groupName);
    const html = `
      <div class="group-card${hidden ? ' group-card--hidden' : ''}" id="${gid}" data-group="${escHtml(groupName)}" onclick="showGroupModal(this.dataset.group)">
        <div class="group-header">
          <div class="group-header-top">
            <span class="group-name">${escHtml(groupName)}</span>
          </div>
          <div class="group-header-meta">
            <span style="font-size:0.72rem;color:var(--text-muted)">${members.length} monitor${members.length !== 1 ? 's' : ''}</span>
            ${statusBadge}
          </div>
        </div>
        ${query && totalCap ? `<div class="capacity-bar-wrap"><div class="capacity-bar"><div class="capacity-fill" style="width:${pct}%"></div></div></div>` : ''}
        ${query ? `<div class="group-items" onclick="event.stopPropagation()">${filteredItemsHTML || '<div style="color:var(--text-muted);font-size:0.82rem;padding:4px 0">No matches</div>'}</div>` : ''}
      </div>`;
    return { id: gid, html };
  });
  updateGrid(grid, groupCards);
}



function onSearch() {
  renderInventory();
  renderGroups();
  renderMonitors();
}

function filteredMonitors(monitors) {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  if (!query) return monitors;
  return monitors.filter(m =>
    (m.label || '').toLowerCase().includes(query) ||
    String(m.entityId).includes(query) ||
    (m.items || []).some(i =>
      getItemName(i.itemId).toLowerCase().includes(query) || String(i.itemId).includes(query)
    )
  );
}

function renderMonitors() {
  const section = document.getElementById('monitorsSection');
  const grid = document.getElementById('monitorsGrid');
  const query = document.getElementById('searchInput').value.toLowerCase().trim();

  if (!query || state.status !== 'connected') {
    section.style.display = 'none';
    return;
  }

  const entityGroups = (state.config || {}).entityGroups || {};
  const all = Object.values(state.monitors || {});
  const filtered = filteredMonitors(all);
  if (filtered.length === 0) { section.style.display = 'none'; return; }

  // Sort by group name (ungrouped last), then by label
  filtered.sort((a, b) => {
    const ga = entityGroups[a.entityId] || '\uffff';
    const gb = entityGroups[b.entityId] || '\uffff';
    if (ga !== gb) return ga.localeCompare(gb);
    return (a.label || '').localeCompare(b.label || '');
  });

  section.style.display = '';
  updateGrid(grid, filtered.map(m => {
    const cardId = `ms-${m.entityId}`;
    return { id: cardId, html: monitorCardHTML(m, query, cardId) };
  }));
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function switchTab(tab) {
  currentTab = tab;
  document.getElementById('tabItems').classList.toggle('active', tab === 'items');
  document.getElementById('tabMonitors').classList.toggle('active', tab === 'monitors');
  document.getElementById('tabContentItems').style.display = tab === 'items' ? '' : 'none';
  document.getElementById('tabContentMonitors').style.display = tab === 'monitors' ? '' : 'none';
  document.getElementById('sortSelect').style.display = tab === 'items' ? '' : 'none';
  document.getElementById('viewToggle').style.display = tab === 'items' ? '' : 'none';
  document.getElementById('searchInput').placeholder = tab === 'items' ? 'Search items…' : 'Search monitors…';
  onSearch();
}

function setView(v) {
  currentView = v;
  document.getElementById('viewGrid').classList.toggle('active', v === 'grid');
  document.getElementById('viewTable').classList.toggle('active', v === 'table');
  renderInventory();
}

function showBanner(msg) {
  const el = document.getElementById('errorBanner');
  if (msg) { el.textContent = msg; el.classList.add('show'); }
  else { el.classList.remove('show'); }
}


function editMonitor(event, id) {
  event.stopPropagation();
  promptedIds.add(String(id));
  _openModal(id);
}

async function removeMonitor(event, id) {
  event.stopPropagation();
  await api('DELETE', `/api/monitor/${id}`);
  promptedIds.delete(id);
}
