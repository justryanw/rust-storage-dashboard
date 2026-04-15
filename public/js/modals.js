// ── Live modal refresh ────────────────────────────────────────────────────────
let _activeModal = null;   // 'monitor' | 'group' | null
let _activeModalArg = null;

function refreshOpenModal() {
  if (_activeModal === 'monitor') showMonitorModal(_activeModalArg._entityId, _activeModalArg._fromGroup);
  else if (_activeModal === 'group') showGroupModal(_activeModalArg);
}

// ── Upkeep modal ─────────────────────────────────────────────────────────────
function showUpkeepModal() {
  const now = Math.floor(Date.now() / 1000);
  const tcs = Object.values(state.monitors || {})
    .filter(m => m.hasProtection && m.protectionExpiry > 0)
    .map(m => ({ ...m, remaining: m.protectionExpiry - now }))
    .sort((a, b) => a.remaining - b.remaining);

  document.getElementById('upkeepModalSub').textContent =
    `${tcs.length} tool cupboard${tcs.length !== 1 ? 's' : ''} with upkeep`;

  document.getElementById('upkeepModalList').innerHTML = tcs.map(tc => {
    const color = upkeepColor(tc.remaining);
    const groupName = ((state.config || {}).entityGroups || {})[String(tc.entityId)] || null;
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface2);border-radius:var(--radius);cursor:pointer" onclick="closeUpkeepModal();showMonitorModal('${tc.entityId}')">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(tc.label || tc.entityId)}</div>
          ${groupName ? `<span class="monitor-group-tag" style="margin-top:2px">${escHtml(groupName)}</span>` : ''}
        </div>
        <span style="font-weight:700;color:${color};white-space:nowrap;font-size:0.95rem">${fmtDuration(tc.remaining)}</span>
      </div>`;
  }).join('');

  document.getElementById('upkeepModal').classList.add('show');
}

function closeUpkeepModal() {
  document.getElementById('upkeepModal').classList.remove('show');
}

// ── Config modal ──────────────────────────────────────────────────────────────
function openConfigModal() {
  document.getElementById('configModal').classList.add('show');
}

function closeConfigModal() {
  document.getElementById('configModal').classList.remove('show');
}


// ── Item detail modal ─────────────────────────────────────────────────────────
function showItemModal(itemId) {
  const item = Object.values(state.inventory || {}).find(i => i.itemId === itemId);
  if (!item) return;

  const entityGroups = (state.config || {}).entityGroups || {};
  const monitors = state.monitors || {};
  const groupBuckets = {};
  const ungrouped = [];

  let totalSlots = 0;
  for (const id of (item.sources || [])) {
    const m = monitors[String(id)];
    const matching = (m?.items || []).filter(i => i.itemId === item.itemId);
    const qty = matching.reduce((s, i) => s + i.quantity, 0);
    const slots = matching.length;
    totalSlots += slots;
    const groupName = entityGroups[String(id)];
    if (groupName) {
      if (!groupBuckets[groupName]) groupBuckets[groupName] = [];
      groupBuckets[groupName].push({ id: String(id), label: m?.label || `#${id}`, qty, slots });
    } else {
      ungrouped.push({ id: String(id), label: m?.label || `#${id}`, qty, slots });
    }
  }

  const maxStack = getMaxStack(item.shortname);
  const minSlots = maxStack ? Math.ceil(item.quantity / maxStack) : null;
  const efficiency = (maxStack && totalSlots > 0) ? Math.round((minSlots / totalSlots) * 100) : null;
  const effColor = efficiency === null ? 'var(--text-muted)'
    : efficiency >= 80 ? 'var(--green)'
    : efficiency >= 50 ? 'var(--yellow)'
    : 'var(--red)';

  const rows = [];
  for (const [groupName, members] of Object.entries(groupBuckets)) {
    const groupTotal = members.reduce((s, m) => s + m.qty, 0);
    const groupSlots = members.reduce((s, m) => s + m.slots, 0);
    rows.push(`
      <div class="item-modal-row item-modal-row-group" data-group="${escHtml(groupName)}" onclick="closeItemModal();showGroupModal(this.dataset.group)">
        <span style="font-size:0.88rem;font-weight:700;flex:1">${escHtml(groupName)}</span>
        <span style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap">${groupSlots} slot${groupSlots !== 1 ? 's' : ''}</span>
        <span style="font-weight:700;color:var(--accent2);min-width:60px;text-align:right">${groupTotal.toLocaleString()}</span>
      </div>`);
    for (const mem of members.sort((a, b) => b.qty - a.qty)) {
      rows.push(`
        <div style="margin-left:16px">
        <div class="item-modal-row item-modal-row-member" data-id="${mem.id}" onclick="closeItemModal();showMonitorModal(this.dataset.id)">
          <span style="font-size:0.82rem;color:var(--text-muted);flex:1">${escHtml(mem.label)}</span>
          <span style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap">${mem.slots} slot${mem.slots !== 1 ? 's' : ''}</span>
          <span style="font-size:0.82rem;color:var(--accent2);min-width:60px;text-align:right">${mem.qty.toLocaleString()}</span>
        </div></div>`);
    }
  }
  for (const s of ungrouped.sort((a, b) => b.qty - a.qty)) {
    rows.push(`
      <div class="item-modal-row item-modal-row-ungrouped" data-id="${s.id}" onclick="closeItemModal();showMonitorModal(this.dataset.id)">
        <span style="font-size:0.88rem;flex:1">${escHtml(s.label)}</span>
        <span style="font-size:0.75rem;color:var(--text-muted);white-space:nowrap">${s.slots} slot${s.slots !== 1 ? 's' : ''}</span>
        <span style="font-weight:700;color:var(--accent2);min-width:60px;text-align:right">${s.qty.toLocaleString()}</span>
      </div>`);
  }

  const locationCount = Object.keys(groupBuckets).length + ungrouped.length;
  const icon = document.getElementById('itemModalIcon');
  icon.src = item.shortname ? `https://wiki.rustclash.com/img/items180/${escHtml(item.shortname)}.png` : '';
  icon.style.display = item.shortname ? '' : 'none';
  document.getElementById('itemModalName').textContent = item.name;

  const effBadge = efficiency !== null
    ? `<span style="font-weight:700;color:${effColor};font-size:0.85rem">${efficiency}% efficient</span>`
    : '';
  const slotsInfo = `${totalSlots} slot${totalSlots !== 1 ? 's' : ''}${maxStack ? ` · ${minSlots} min needed` : ''}`;
  document.getElementById('itemModalTotal').innerHTML =
    `${item.quantity.toLocaleString()} total across ${locationCount} location${locationCount !== 1 ? 's' : ''}`
    + `<br><span style="font-size:0.78rem;color:var(--text-muted)">${slotsInfo}</span> ${effBadge}`;
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
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px">
      <div>
        <h2 style="margin-bottom:4px">${escHtml(m.label || m.entityId)}</h2>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${groupName ? `<span class="monitor-group-tag">${escHtml(groupName)}</span>` : ''}
          ${statusBadge}
          ${m.lastUpdated ? `<span class="monitor-updated" data-updated="${m.lastUpdated}">${timeAgo(m.lastUpdated)}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="btn btn-icon" id="modalRefreshBtn-${m.entityId}" onclick="refreshMonitor(event,'${m.entityId}')" title="Refresh monitor"><span class="btn-icon-inner">↻</span></button>
        <button class="btn btn-icon" onclick="editMonitor(event,'${m.entityId}')" title="Rename monitor">✏️</button>
        <button class="btn btn-icon btn-danger-icon" onclick="removeMonitor(event,'${m.entityId}');closeMonitorModal()" title="Delete monitor">🗑</button>
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
  const _slotHidden = isGroupSlotHidden(groupName);
  const _searchOnly = isGroupSearchOnly(groupName);
  document.getElementById('groupDetailContent').innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:12px">
      <div>
        <h2 style="margin-bottom:4px">${escHtml(groupName)}</h2>
        <span style="font-size:0.78rem;color:var(--text-muted)">${members.length} monitor${members.length !== 1 ? 's' : ''} · ${totalUsed}/${totalCap} slots (${pct}%)</span>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="btn btn-icon" data-group="${escHtml(groupName)}" onclick="showRenameGroupModal(this.dataset.group)" title="Rename group">✏️</button>
      </div>
    </div>
    <div class="modal-toggles">
      <label class="modal-toggle" onclick="toggleGroupVisibility('${escHtml(groupName)}');showGroupModal('${escHtml(groupName)}')">
        <span class="modal-toggle-indicator${_hidden ? '' : ' active'}"></span>
        <span>Show in item list</span>
      </label>
      <label class="modal-toggle" onclick="toggleGroupSlotVisibility('${escHtml(groupName)}');showGroupModal('${escHtml(groupName)}')">
        <span class="modal-toggle-indicator${_slotHidden ? '' : ' active'}"></span>
        <span>Include in slot counts</span>
      </label>
      <label class="modal-toggle" onclick="toggleGroupSearchOnly('${escHtml(groupName)}');showGroupModal('${escHtml(groupName)}')">
        <span class="modal-toggle-indicator${_searchOnly ? ' active' : ''}"></span>
        <span>Show items only when searching</span>
      </label>
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

// ── Switch rename modal ────────────────────────────────────────────────────────
let pendingSwitchId = null;

function showSwitchPairModal(paired) {
  pendingSwitchId = paired.entityId;
  document.getElementById('switchRenameTitle').textContent = 'Name this Switch';
  document.getElementById('switchRenameSub').textContent = `Entity ID: ${paired.entityId}`;
  document.getElementById('switchRenameInput').value = 'Smart Switch';
  document.getElementById('switchRenameModal').classList.add('show');
  setTimeout(() => document.getElementById('switchRenameInput').focus(), 50);
}

function showSwitchRenameModal(entityId) {
  pendingSwitchId = entityId;
  const sw = (state.switches || {})[String(entityId)];
  document.getElementById('switchRenameTitle').textContent = 'Rename Switch';
  document.getElementById('switchRenameSub').textContent = `Entity ID: ${entityId}`;
  document.getElementById('switchRenameInput').value = sw?.label || '';
  document.getElementById('switchRenameModal').classList.add('show');
  setTimeout(() => document.getElementById('switchRenameInput').select(), 50);
}

async function saveSwitchRename() {
  const name = document.getElementById('switchRenameInput').value.trim();
  if (!name) return;
  const id = pendingSwitchId;
  dismissSwitchRenameModal();

  // Determine if this is a new switch (pair) or existing (rename)
  const existingIds = (state.config?.switchIds || []).map(String);
  if (existingIds.includes(String(id))) {
    await api('POST', `/api/switch/${id}/rename`, { name });
  } else {
    await api('POST', '/api/switch/confirm', { entityId: id, name });
  }
}

function dismissSwitchRenameModal() {
  pendingSwitchId = null;
  document.getElementById('switchRenameModal').classList.remove('show');
  document.getElementById('switchRenameInput').value = '';
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
