// ── Config modal ──────────────────────────────────────────────────────────────
function openConfigModal() {
  document.getElementById('configModal').classList.add('show');
}

function closeConfigModal() {
  document.getElementById('configModal').classList.remove('show');
}

// ── Slots usage modal ─────────────────────────────────────────────────────────
function showSlotsModal() {
  // Count stacks (slots) per itemId across all monitors
  const slotCounts = {};
  for (const m of Object.values(state.monitors || {})) {
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
  const monitors = Object.values(state.monitors || {}).filter(m => !m.error && !m.unpowered);
  const totalSlots = monitors.reduce((s, m) => s + (m.capacity || 0), 0);

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
      groupBuckets[groupName].push({ label: m?.label || `#${id}`, qty });
    } else {
      ungrouped.push({ label: m?.label || `#${id}`, qty });
    }
  }

  const rows = [];
  for (const [groupName, members] of Object.entries(groupBuckets)) {
    const groupTotal = members.reduce((s, m) => s + m.qty, 0);
    rows.push(`
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--surface2);border-radius:var(--radius);border-left:3px solid var(--accent)">
        <span style="font-size:0.88rem;font-weight:700">🗃 ${escHtml(groupName)}</span>
        <span style="font-weight:700;color:var(--accent2)">${groupTotal.toLocaleString()}</span>
      </div>`);
    for (const mem of members.sort((a, b) => b.qty - a.qty)) {
      rows.push(`
        <div style="margin-left:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 12px;background:var(--bg);border-radius:var(--radius);border-left:2px solid var(--border)">
          <span style="font-size:0.82rem;color:var(--text-muted)">📦 ${escHtml(mem.label)}</span>
          <span style="font-size:0.82rem;color:var(--accent2)">${mem.qty.toLocaleString()}</span>
        </div></div>`);
    }
  }
  for (const s of ungrouped.sort((a, b) => b.qty - a.qty)) {
    rows.push(`
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--surface2);border-radius:var(--radius)">
        <span style="font-size:0.88rem">📦 ${escHtml(s.label)}</span>
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
    ? filtered.map(g => `<div class="group-dropdown-item" onmousedown='selectGroup(${JSON.stringify(g)})'>${escHtml(g)}</div>`).join('')
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
