// ── Utilities ─────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
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

function itemSources(item) {
  const entityGroups = (state.config || {}).entityGroups || {};
  const monitors = state.monitors || {};
  const groupTotals = {};
  const ungrouped = [];
  for (const id of (item.sources || [])) {
    const m = monitors[id];
    const qty = (m?.items || []).filter(i => i.itemId === item.itemId).reduce((s, i) => s + i.quantity, 0);
    const groupName = entityGroups[String(id)];
    if (groupName) {
      groupTotals[groupName] = (groupTotals[groupName] || 0) + qty;
    } else {
      ungrouped.push({ id, label: m?.label || `#${id}`, qty, isGroup: false });
    }
  }
  const grouped = Object.entries(groupTotals).map(([name, qty]) => ({ id: null, label: name, qty, isGroup: true }));
  return [...grouped, ...ungrouped].sort((a, b) => b.qty - a.qty);
}

function sourceListHTML(sources, max) {
  const shown = sources.slice(0, max);
  const rest = sources.length - max;
  return `<div class="source-list">
    ${shown.map(s => `<span class="source-row${s.isGroup ? ' is-group' : ''}"><span class="source-row-name">${escHtml(s.label)}</span><span class="source-row-qty">×${fmt(s.qty)}</span></span>`).join('')}
    ${rest > 0 ? `<span class="source-more">+${rest}</span>` : ''}
  </div>`;
}

// ── Card HTML generators ──────────────────────────────────────────────────────
function itemCardHTML(item) {
  const sources = itemSources(item);
  return `
    <div class="item-card" style="cursor:pointer" onclick="showItemModal(${item.itemId})" title="Click to see all locations">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        ${itemIconHTML(item.shortname)}
        <div style="min-width:0">
          <div class="item-name">${escHtml(item.name)}</div>
          <div class="item-qty">${fmt(item.quantity)}</div>
        </div>
      </div>
      ${item.isBlueprint ? '<div style="margin-bottom:4px"><span class="item-bp">BP</span></div>' : ''}
      ${sourceListHTML(sources, 3)}
    </div>`;
}

function tableRowHTML(item) {
  const sources = itemSources(item);
  return `
    <tr style="cursor:pointer" onclick="showItemModal(${item.itemId})" title="Click to see all locations">
      <td style="display:flex;align-items:center;gap:8px">${itemIconHTML(item.shortname, 24)}${escHtml(item.name)}${item.isBlueprint ? ' <span class="item-bp">BP</span>' : ''}</td>
      <td class="qty-cell">${item.quantity.toLocaleString()}</td>
      <td>${sourceListHTML(sources, 2)}</td>
    </tr>`;
}

function monitorCardHTML(m, query = '', cardId = `mc-${m.entityId}`) {
  const usedSlots = (m.items || []).length;
  const cap = m.capacity || 0;
  const pct = cap ? Math.round((usedSlots / cap) * 100) : 0;
  const isRemoved = m.error === 'not_found';
  const isUnpowered = m.unpowered;
  const groupName = ((state.config || {}).entityGroups || {})[String(m.entityId)] || null;
  const mergedItems = {};
  for (const item of (m.items || [])) {
    const key = String(item.itemId);
    if (!mergedItems[key]) mergedItems[key] = { itemId: item.itemId, quantity: 0 };
    mergedItems[key].quantity += item.quantity;
  }
  const itemsHTML = Object.values(mergedItems)
    .filter(item => !query || getItemName(item.itemId).toLowerCase().includes(query) || String(item.itemId).includes(query))
    .sort((a, b) => b.quantity - a.quantity)
    .map(item => `
      <div class="monitor-item">
        ${itemIconHTML(getItemShortname(item.itemId), 24)}
        <span class="monitor-item-name">${escHtml(getItemName(item.itemId))}</span>
        <span class="monitor-item-qty">${item.quantity.toLocaleString()}</span>
      </div>`).join('');
  const statusBadge = isRemoved
    ? `<span style="font-size:0.72rem;background:#3b0f0f;color:var(--red);border:1px solid #7f1d1d;border-radius:4px;padding:1px 6px">No Response</span>`
    : isUnpowered
    ? `<span style="font-size:0.72rem;background:#2a1f00;color:var(--yellow);border:1px solid #78580a;border-radius:4px;padding:1px 6px">Unpowered</span>`
    : m.error
    ? `<span class="monitor-error">⚠ ${escHtml(m.error)}</span>`
    : `<span class="monitor-capacity">${usedSlots}/${cap} slots (${pct}%)</span>`;
  return `
    <div class="monitor-card" id="${cardId}" ${isRemoved ? 'style="opacity:0.5"' : ''}>
      <div class="monitor-header" onclick="toggleMonitor(event)">
        <div class="monitor-header-top">
          <span class="monitor-name">📦 ${escHtml(m.label || m.entityId)}</span>
          <button class="monitor-edit" onclick="editMonitor(event,'${m.entityId}')" title="Edit monitor">✏️</button>
          <button class="monitor-delete" onclick="removeMonitor(event,'${m.entityId}')" title="Remove monitor">🗑</button>
        </div>
        <div class="monitor-header-meta">
          ${groupName ? `<span class="monitor-group-tag">${escHtml(groupName)}</span>` : ''}
          ${statusBadge}
        </div>
      </div>
      ${!m.error && !isUnpowered && cap ? `
        <div class="capacity-bar-wrap" style="padding:0 16px 6px">
          <div class="capacity-bar"><div class="capacity-fill" style="width:${pct}%"></div></div>
        </div>` : ''}
      <div class="monitor-items">
        ${isRemoved || isUnpowered ? '' : (itemsHTML || '<div style="color:var(--text-muted);font-size:0.82rem;padding:4px 0">Empty</div>')}
      </div>
    </div>`;
}

// ── DOM diffing helpers ───────────────────────────────────────────────────────
function patchInner(existingEl, newEl, selector) {
  const a = existingEl.querySelector(selector);
  const b = newEl.querySelector(selector);
  if (a && b && a.innerHTML !== b.innerHTML) a.innerHTML = b.innerHTML;
}

function patchAttr(existingEl, newEl, selector, attr) {
  const a = existingEl.querySelector(selector);
  const b = newEl.querySelector(selector);
  if (a && b && a.getAttribute(attr) !== b.getAttribute(attr)) a.setAttribute(attr, b.getAttribute(attr));
}

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
        // Patch inner sections — never recreate the scroll container
        patchInner(el, newEl, '.monitor-items');
        patchInner(el, newEl, '.group-items');
        // Full header replacement for status badge / name changes
        const oldHeader = el.querySelector('.monitor-header, .group-header');
        const newHeader = newEl.querySelector('.monitor-header, .group-header');
        if (oldHeader && newHeader && oldHeader.innerHTML !== newHeader.innerHTML) {
          oldHeader.innerHTML = newHeader.innerHTML;
        }
        // Capacity/group bar
        const oldBar = el.querySelector('.group-bar, .capacity-bar-wrap');
        const newBar = newEl.querySelector('.group-bar, .capacity-bar-wrap');
        if ((oldBar?.outerHTML || '') !== (newBar?.outerHTML || '')) {
          if (oldBar && newBar) oldBar.replaceWith(newBar);
          else if (oldBar) oldBar.remove();
          else if (newBar) el.insertBefore(newBar, el.querySelector('.monitor-items, .group-items'));
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
  renderUngrouped();
  renderMonitors();
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
  if (status !== 'connected') { pollBarStart = null; refreshBtn.style.background = ''; }

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
  const monitors = Object.values(state.monitors || {}).filter(m => !m.error && !m.unpowered);
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
}

function getSortedItems() {
  const query = document.getElementById('searchInput').value.toLowerCase();
  const sort = document.getElementById('sortSelect').value;
  let items = Object.values(state.inventory || {});

  if (query) items = items.filter(i => i.name.toLowerCase().includes(query) || String(i.itemId).includes(query));

  items.sort((a, b) => {
    if (sort === 'qty-desc') return b.quantity - a.quantity;
    if (sort === 'qty-asc') return a.quantity - b.quantity;
    if (sort === 'name-asc') return a.name.localeCompare(b.name);
    if (sort === 'name-desc') return b.name.localeCompare(a.name);
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

  if (currentView === 'grid') {
    container.innerHTML = `<div class="inventory-grid">${items.map(itemCardHTML).join('')}</div>`;
  } else {
    container.innerHTML = `
      <div class="table-wrap">
        <table class="inventory-table">
          <thead>
            <tr>
              <th onclick="cycleSortTable('name')">Item <span class="sort-arrow" id="th-name"></span></th>
              <th onclick="cycleSortTable('qty-desc')">Quantity <span class="sort-arrow" id="th-qty">↓</span></th>
              <th>Monitors</th>
            </tr>
          </thead>
          <tbody>${items.map(tableRowHTML).join('')}</tbody>
        </table>
      </div>`;
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
    const html = `
      <div class="group-card" id="${gid}">
        <div class="group-header" onclick="toggleGroup('${gid}')">
          <span class="group-name">🗃 ${escHtml(groupName)}</span>
          <span style="font-size:0.72rem;color:var(--text-muted)">${members.length} monitor${members.length !== 1 ? 's' : ''}</span>
          ${statusBadge}
        </div>
        ${totalCap ? `<div class="group-bar" style="padding:0 16px 6px;background:var(--surface2)">
          <div class="capacity-bar"><div class="capacity-fill" style="width:${pct}%"></div></div>
        </div>` : ''}
        <div class="group-items">
          ${itemsHTML || '<div style="color:var(--text-muted);font-size:0.82rem;padding:4px 0">Empty</div>'}
        </div>
      </div>`;
    return { id: gid, html };
  });
  updateGrid(grid, groupCards);
}

function toggleGroup(gid) {
  const card = document.getElementById(gid);
  if (card) card.classList.toggle('group-collapsed');
}

function renderSection(sectionId, gridId, entries, allEntries) {
  const section = document.getElementById(sectionId);
  const grid = document.getElementById(gridId);
  if (allEntries.length === 0 || entries.length === 0 || state.status !== 'connected') { section.style.display = 'none'; return; }
  section.style.display = '';
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  updateGrid(grid, entries.map(m => {
    const cardId = `${gridId}-${m.entityId}`;
    return { id: cardId, html: monitorCardHTML(m, query, cardId) };
  }));
}

function onSearch() {
  renderInventory();
  renderGroups();
  renderUngrouped();
  renderMonitors();
}

function filteredMonitors(monitors) {
  const query = document.getElementById('searchInput').value.toLowerCase().trim();
  if (!query) return monitors;
  return monitors.filter(m => (m.items || []).some(i =>
    getItemName(i.itemId).toLowerCase().includes(query) || String(i.itemId).includes(query)
  ));
}

function renderUngrouped() {
  const entityGroups = (state.config || {}).entityGroups || {};
  const all = Object.values(state.monitors || {}).filter(m => !entityGroups[m.entityId]);
  renderSection('ungroupedSection', 'ungroupedGrid', filteredMonitors(all), all);
}

function renderMonitors() {
  const entityGroups = (state.config || {}).entityGroups || {};
  const all = Object.values(state.monitors || {}).filter(m => entityGroups[m.entityId]);
  renderSection('monitorsSection', 'monitorsGrid', filteredMonitors(all), all);
}

// ── UI helpers ────────────────────────────────────────────────────────────────
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

function toggleMonitor(event) {
  event.currentTarget.closest('.monitor-card').classList.toggle('monitor-collapsed');
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
