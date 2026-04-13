// ── Live modal refresh ────────────────────────────────────────────────────────
let _activeModal = null;   // 'monitor' | 'group' | null
let _activeModalArg = null;

function refreshOpenModal() {
  if (_activeModal === 'monitor') showMonitorModal(_activeModalArg._entityId, _activeModalArg._fromGroup);
  else if (_activeModal === 'group') showGroupModal(_activeModalArg);
}

// ── Config modal ──────────────────────────────────────────────────────────────
function openConfigModal() {
  document.getElementById('configModal').classList.add('show');
}

function closeConfigModal() {
  document.getElementById('configModal').classList.remove('show');
}

// ── Slots usage modal ─────────────────────────────────────────────────────────
function showSlotsModal() {
  // Count stacks (slots) per itemId across visible monitors
  const entityGroups = (state.config || {}).entityGroups || {};
  const visibleMonitors = Object.values(state.monitors || {}).filter(m => {
    if (m.error || m.unpowered) return false;
    const groupName = entityGroups[String(m.entityId)];
    return !groupName || !isGroupHidden(groupName);
  });
  const slotCounts = {};
  for (const m of visibleMonitors) {
    for (const item of (m.items || [])) {
      const key = String(item.itemId);
      slotCounts[key] = (slotCounts[key] || 0) + 1;
    }
  }

  const items = Object.values(state.inventory || {})
    .map(item => ({ ...item, slots: slotCounts[String(item.itemId)] || 0 }))
    .filter(item => item.slots > 0)
    .sort((a, b) => b.slots - a.slots || b.quantity - a.quantity);

  const totalUsed = items.reduce((s, i) => s + i.slots, 0);
  const totalSlots = visibleMonitors.reduce((s, m) => s + (m.capacity || 0), 0);

  document.getElementById('slotsModalSub').textContent =
    `${totalUsed} of ${totalSlots} slots used across ${items.length} item type${items.length !== 1 ? 's' : ''}`;

  document.getElementById('slotsModalList').innerHTML = items.map(item => {
    const pct = totalUsed > 0 ? (item.slots / totalUsed) * 100 : 0;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 10px;background:var(--surface2);border-radius:var(--radius)">
        ${itemIconHTML(item.shortname, 24)}
        <span style="flex:1;font-size:0.85rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(item.name)}</span>
        <span style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap">${item.quantity.toLocaleString()} qty</span>
        <span style="font-weight:700;color:var(--accent2);white-space:nowrap;min-width:52px;text-align:right">${item.slots} slot${item.slots !== 1 ? 's' : ''}</span>
      </div>`;
  }).join('');

  document.getElementById('slotsModal').classList.add('show');
}

function closeSlotsModal() {
  document.getElementById('slotsModal').classList.remove('show');
}

// ── Item detail modal ─────────────────────────────────────────────────────────
function showItemModal(itemId) {
  const item = Object.values(state.inventory || {}).find(i => i.itemId === itemId);
  if (!item) return;

  const entityGroups = (state.config || {}).entityGroups || {};
  const monitors = state.monitors || {};
  const groupBuckets = {};
  const ungrouped = [];

  for (const id of (item.sources || [])) {
    const m = monitors[String(id)];
    const qty = (m?.items || []).filter(i => i.itemId === item.itemId).reduce((s, i) => s + i.quantity, 0);
    const groupName = entityGroups[String(id)];
    if (groupName) {
      if (!groupBuckets[groupName]) groupBuckets[groupName] = [];
      groupBuckets[groupName].push({ id: String(id), label: m?.label || `#${id}`, qty });
    } else {
      ungrouped.push({ id: String(id), label: m?.label || `#${id}`, qty });
    }
  }

  const rows = [];
  for (const [groupName, members] of Object.entries(groupBuckets)) {
    const groupTotal = members.reduce((s, m) => s + m.qty, 0);
    rows.push(`
      <div class="item-modal-row item-modal-row-group" data-group="${escHtml(groupName)}" onclick="closeItemModal();showGroupModal(this.dataset.group)">
        <span style="font-size:0.88rem;font-weight:700">${escHtml(groupName)}</span>
        <span style="font-weight:700;color:var(--accent2)">${groupTotal.toLocaleString()}</span>
      </div>`);
    for (const mem of members.sort((a, b) => b.qty - a.qty)) {
      rows.push(`
        <div style="margin-left:16px">
        <div class="item-modal-row item-modal-row-member" data-id="${mem.id}" onclick="closeItemModal();showMonitorModal(this.dataset.id)">
          <span style="font-size:0.82rem;color:var(--text-muted)">${escHtml(mem.label)}</span>
          <span style="font-size:0.82rem;color:var(--accent2)">${mem.qty.toLocaleString()}</span>
        </div></div>`);
    }
  }
  for (const s of ungrouped.sort((a, b) => b.qty - a.qty)) {
    rows.push(`
      <div class="item-modal-row item-modal-row-ungrouped" data-id="${s.id}" onclick="closeItemModal();showMonitorModal(this.dataset.id)">
        <span style="font-size:0.88rem">${escHtml(s.label)}</span>
        <span style="font-weight:700;color:var(--accent2)">${s.qty.toLocaleString()}</span>
      </div>`);
  }

  const locationCount = Object.keys(groupBuckets).length + ungrouped.length;
  const icon = document.getElementById('itemModalIcon');
  icon.src = item.shortname ? `https://wiki.rustclash.com/img/items180/${escHtml(item.shortname)}.png` : '';
  icon.style.display = item.shortname ? '' : 'none';
  document.getElementById('itemModalName').textContent = item.name;
  document.getElementById('itemModalTotal').textContent = `${item.quantity.toLocaleString()} total across ${locationCount} location${locationCount !== 1 ? 's' : ''}`;
  document.getElementById('itemModalList').innerHTML = rows.join('');
  document.getElementById('itemModal').classList.add('show');
}

function closeItemModal() {
  document.getElementById('itemModal').classList.remove('show');
}

// ── Pair / rename modal ───────────────────────────────────────────────────────
let pendingPairId = null;

function renderGroupDropdown(groups) {
  const dropdown = document.getElementById('groupDropdown');
  const query = document.getElementById('pairGroupInput').value.toLowerCase();
  const filtered = groups.filter(g => g.toLowerCase().includes(query));
  dropdown.innerHTML = filtered.length
    ? filtered.map(g => `<div class="group-dropdown-item" onmousedown="event.preventDefault()" onclick='selectGroup(${JSON.stringify(g)})'>${escHtml(g)}</div>`).join('')
    : (groups.length ? '<div class="group-dropdown-empty">No matches</div>' : '<div class="group-dropdown-empty">No existing groups</div>');
}

function toggleGroupDropdown() {
  const dropdown = document.getElementById('groupDropdown');
  const isOpen = dropdown.style.display !== 'none';
  if (isOpen) { closeGroupDropdown(); } else { openGroupDropdown(); }
}

function _groupClickOutside(e) {
  if (!document.getElementById('groupCombobox').contains(e.target)) closeGroupDropdown();
}

function openGroupDropdown() {
  const groups = JSON.parse(document.getElementById('groupCombobox').dataset.groups || '[]');
  renderGroupDropdown(groups);
  document.getElementById('groupDropdown').style.display = '';
  document.getElementById('pairGroupInput').focus();
  document.addEventListener('mousedown', _groupClickOutside);
}

function closeGroupDropdown() {
  document.getElementById('groupDropdown').style.display = 'none';
  document.removeEventListener('mousedown', _groupClickOutside);
}

function filterGroupDropdown() {
  const dropdown = document.getElementById('groupDropdown');
  if (dropdown.style.display === 'none') return;
  const groups = JSON.parse(document.getElementById('groupCombobox').dataset.groups || '[]');
  renderGroupDropdown(groups);
}

function selectGroup(name) {
  document.getElementById('pairGroupInput').value = name;
  closeGroupDropdown();
}

function _openModal(entityId) {
  pendingPairId = entityId;
  const cfg = state.config || {};
  const existingIds = new Set((cfg.entityIds || []).map(String));
  const isExisting = existingIds.has(String(entityId));
  document.querySelector('#pairModal h2').textContent = isExisting ? 'Rename Monitor' : 'Add Monitor';
  document.getElementById('pairModalSub').textContent = `Entity ID: ${entityId}`;
  const existingLabel = (cfg.entityLabels || {})[entityId];
  document.getElementById('pairNameInput').value = existingLabel || 'Storage Monitor';
  const existingGroup = (cfg.entityGroups || {})[String(entityId)] || '';
  document.getElementById('pairGroupInput').value = existingGroup;
  const allGroups = [...new Set(Object.values(cfg.entityGroups || {}))];
  document.getElementById('groupCombobox').dataset.groups = JSON.stringify(allGroups);
  renderGroupDropdown(allGroups);
  document.getElementById('pairModal').classList.add('show');
  setTimeout(() => document.getElementById('pairNameInput').focus(), 50);
}

function showPairModal(paired) {
  _openModal(paired.entityId);
}

async function savePairName() {
  await _closeModal(document.getElementById('pairNameInput').value.trim());
}

function dismissPairModal() {
  _closeModal(null);
}

// ── Monitor detail modal ──────────────────────────────────────────────────────
function showMonitorModal(entityId, fromGroup = null) {
  _activeModal = 'monitor';
  _activeModalArg = { _entityId: entityId, _fromGroup: fromGroup };
  const m = (state.monitors || {})[String(entityId)];
  if (!m) return;
  const usedSlots = (m.items || []).length;
  const cap = m.capacity || 0;
  const pct = cap ? Math.round((usedSlots / cap) * 100) : 0;
  const isUnpowered = m.unpowered;
  const isRemoved = m.error === 'not_found';
  const groupName = ((state.config || {}).entityGroups || {})[String(entityId)] || null;
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
  const itemsHTML = Object.values(mergedItems).sort((a, b) => b.quantity - a.quantity).map(item => `
    <div class="monitor-item">
      ${itemIconHTML(getItemShortname(item.itemId), 24)}
      <span class="monitor-item-name">${escHtml(getItemName(item.itemId))}</span>
      <span class="monitor-item-qty">${item.quantity.toLocaleString()}</span>
    </div>`).join('');
  // Build inventory grid — one cell per slot
  const items = m.items || [];
  let gridHTML = '';
  if (cap > 0 && !isRemoved) {
    const cells = [];
    for (let i = 0; i < cap; i++) {
      const item = items[i];
      if (item && item.itemId) {
        const sn = getItemShortname(item.itemId);
        const name = escHtml(getItemName(item.itemId));
        const qty = item.quantity > 1 ? `<span class="inv-grid-qty">${fmt(item.quantity)}</span>` : '';
        cells.push(`<div class="inv-grid-cell inv-grid-cell--filled" title="${name} ×${item.quantity.toLocaleString()}">${itemIconHTML(sn, 40)}${qty}</div>`);
      } else {
        cells.push('<div class="inv-grid-cell"></div>');
      }
    }
    gridHTML = `<div class="inv-grid">${cells.join('')}</div>`;
  }

  document.getElementById('monitorDetailContent').innerHTML = `
    ${fromGroup ? `<button class="modal-back-btn" onclick="closeMonitorModal();showGroupModal(this.dataset.group)" data-group="${escHtml(fromGroup)}">← ${escHtml(fromGroup)}</button>` : ''}
    <div style="margin-bottom:12px">
      <h2 style="margin-bottom:4px">${escHtml(m.label || m.entityId)}</h2>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        ${groupName ? `<span class="monitor-group-tag">${escHtml(groupName)}</span>` : ''}
        ${statusBadge}
        ${m.lastUpdated ? `<span class="monitor-updated" data-updated="${m.lastUpdated}">${timeAgo(m.lastUpdated)}</span>` : ''}
      </div>
    </div>
    ${!m.error && !isUnpowered && cap ? `<div class="capacity-bar" style="margin-bottom:12px"><div class="capacity-fill" style="width:${pct}%"></div></div>` : ''}
    <div class="monitor-detail-body">
      ${gridHTML ? `<div class="monitor-detail-grid">
        <div class="detail-section-label">Inventory</div>
        ${gridHTML}
      </div>` : ''}
      <div class="monitor-detail-summary">
        <div class="detail-section-label">Summary</div>
        <div class="detail-items">
          ${isRemoved ? `<div style="color:var(--text-muted);font-size:0.85rem">No data available</div>` : (itemsHTML || '<div style="color:var(--text-muted);font-size:0.85rem">Empty</div>')}
        </div>
      </div>
    </div>`;
  document.getElementById('monitorDetailModal').classList.add('show');
}

function closeMonitorModal() {
  _activeModal = null;
  _activeModalArg = null;
  document.getElementById('monitorDetailModal').classList.remove('show');
}

// ── Group detail modal ────────────────────────────────────────────────────────
function showGroupModal(groupName) {
  _activeModal = 'group';
  _activeModalArg = groupName;
  const monitors = state.monitors || {};
  const entityGroups = (state.config || {}).entityGroups || {};
  const members = Object.entries(monitors)
    .filter(([id]) => entityGroups[id] === groupName)
    .map(([, m]) => m);

  const mergedItems = {};
  let totalUsed = 0, totalCap = 0;
  for (const m of members) {
    totalCap += m.capacity || 0;
    totalUsed += (m.items || []).length;
    for (const item of (m.items || [])) {
      const key = String(item.itemId);
      if (!mergedItems[key]) mergedItems[key] = { itemId: item.itemId, quantity: 0 };
      mergedItems[key].quantity += item.quantity;
    }
  }
  const pct = totalCap ? Math.round((totalUsed / totalCap) * 100) : 0;

  const combinedHTML = Object.values(mergedItems).sort((a, b) => b.quantity - a.quantity).map(item => `
    <div class="monitor-item">
      ${itemIconHTML(getItemShortname(item.itemId), 24)}
      <span class="monitor-item-name">${escHtml(getItemName(item.itemId))}</span>
      <span class="monitor-item-qty">${item.quantity.toLocaleString()}</span>
    </div>`).join('');

  const memberCardsHTML = members.map(m => {
    const used = (m.items || []).length;
    const cap = m.capacity || 0;
    const p = cap ? Math.round((used / cap) * 100) : 0;
    const isUnpowered = m.unpowered;
    const isRemoved = m.error === 'not_found';
    const badge = isRemoved
      ? `<span style="font-size:0.72rem;background:#3b0f0f;color:var(--red);border:1px solid #7f1d1d;border-radius:4px;padding:1px 6px">No Response</span>`
      : isUnpowered
      ? `<span style="font-size:0.72rem;background:#2a1f00;color:var(--yellow);border:1px solid #78580a;border-radius:4px;padding:1px 6px">Unpowered</span>`
      : m.error
      ? `<span class="monitor-error">⚠ ${escHtml(m.error)}</span>`
      : `<span class="monitor-capacity">${used}/${cap} slots (${p}%)</span>`;
    return `
      <div class="detail-member-card" ${isRemoved ? 'style="opacity:0.5"' : ''} data-entity="${m.entityId}" data-group="${escHtml(groupName)}" onclick="showMonitorModal(this.dataset.entity,this.dataset.group)">
        <div class="detail-member-header">
          <span class="detail-member-name">${escHtml(m.label || m.entityId)}</span>
          ${badge}
        </div>
        ${!m.error && !isUnpowered && cap ? `<div class="capacity-bar" style="margin:6px 12px 8px"><div class="capacity-fill" style="width:${p}%"></div></div>` : ''}
      </div>`;
  }).join('');

  const _hidden = isGroupHidden(groupName);
  document.getElementById('groupDetailContent').innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px">
      <div>
        <h2 style="margin-bottom:4px">${escHtml(groupName)}</h2>
        <span style="font-size:0.78rem;color:var(--text-muted)">${members.length} monitor${members.length !== 1 ? 's' : ''} · ${totalUsed}/${totalCap} slots (${pct}%)</span>
      </div>
      <button class="group-visibility-btn${_hidden ? ' group-visibility-btn--hidden' : ''}" data-group="${escHtml(groupName)}" onclick="toggleGroupVisibility(this.dataset.group);showGroupModal(this.dataset.group)" title="${_hidden ? 'Show in inventory' : 'Hide from inventory'}" style="margin-top:4px;font-size:1rem;flex-shrink:0">◉</button>
    </div>
    ${totalCap ? `<div class="capacity-bar" style="margin-bottom:16px"><div class="capacity-fill" style="width:${pct}%"></div></div>` : ''}
    <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">All Items</div>
    <div class="detail-items" style="margin-bottom:20px">
      ${combinedHTML || '<div style="color:var(--text-muted);font-size:0.85rem">Empty</div>'}
    </div>
    <div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">Monitors</div>
    <div style="display:flex;flex-direction:column;gap:8px">${memberCardsHTML}</div>`;
  document.getElementById('groupDetailModal').classList.add('show');
}

function closeGroupModal() {
  _activeModal = null;
  _activeModalArg = null;
  document.getElementById('groupDetailModal').classList.remove('show');
}

// ── Rename group modal ────────────────────────────────────────────────────────
let pendingGroupName = null;

function showRenameGroupModal(name) {
  pendingGroupName = name;
  document.getElementById('renameGroupInput').value = name;
  document.getElementById('renameGroupModal').classList.add('show');
  setTimeout(() => document.getElementById('renameGroupInput').select(), 50);
}

async function saveRenameGroup() {
  const newName = document.getElementById('renameGroupInput').value.trim();
  if (!newName) return;
  const oldName = pendingGroupName;
  dismissRenameGroupModal();
  await api('POST', '/api/rename-group', { oldName, newName });
}

function dismissRenameGroupModal() {
  pendingGroupName = null;
  document.getElementById('renameGroupModal').classList.remove('show');
  document.getElementById('renameGroupInput').value = '';
}

async function _closeModal(name) {
  const id = pendingPairId;
  pendingPairId = null;
  const group = document.getElementById('pairGroupInput').value.trim();
  document.getElementById('pairModal').classList.remove('show');
  document.getElementById('pairNameInput').value = '';
  document.getElementById('pairGroupInput').value = '';
  closeGroupDropdown();

  if (name !== null) {
    await api('POST', '/api/monitor/confirm', { entityId: id, name: name || undefined, group: group || undefined });
  }
  if (monitorQueue.length > 0) showPairModal(monitorQueue.shift());
}
