// ── PixiJS Map Module ─────────────────────────────────────────────────────────
// Self-contained map rendering with PixiJS. Exposes: loadMap(), refreshMapMarkers()

let _pixiApp = null;
let _mapContainer = null;
let _mapSprite = null;
let _markersContainer = null;
let _drawCanvas = null;      // offscreen HTML canvas for painting
let _drawCtx = null;          // 2D context of _drawCanvas
let _drawSprite = null;       // PIXI.Sprite showing _drawCanvas as texture
let _drawTexture = null;      // PIXI.Texture wrapping _drawCanvas
let _mapLoaded = false;
let _mapMarkers = null;
let _mapMeta = null;
let _drawMode = false;
let _eraseMode = false;
let _penDown = false;
let _lastDrawPt = null;
let _drawColor = '#e8622a';
let _drawWidth = 3;
let _drawDirty = false;
let _saveTimer = null;
let _brushCursor = null;
let _vendingPopupMarker = null;

const MARKER_TYPES = {
  1: { label: 'Player', color: 0x4ade80 },
  2: { label: 'Explosion', color: 0xf87171 },
  3: { label: 'Vending Machine', color: 0x60a5fa },
  4: { label: 'CH47', color: 0xfacc15 },
  5: { label: 'Cargo Ship', color: 0xf97316 },
  6: { label: 'Crate', color: 0xa78bfa },
  7: { label: 'Radius', color: 0xfacc15 },
  8: { label: 'Attack Helicopter', color: 0xef4444 },
};

function hexToNum(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

// ── Coordinate conversion ────────────────────────────────────────────────────
function worldToPixel(wx, wy) {
  if (!_mapSprite || !_mapMeta) return { x: 0, y: 0 };
  const imgW = _mapSprite.texture.width;
  const imgH = _mapSprite.texture.height;
  const margin = _mapMeta.oceanMargin || 0;
  const mapSize = _mapMeta.mapSize || 1;
  const s = (imgW - 2 * margin) / mapSize;
  return {
    x: margin + wx * s,
    y: imgH - (margin + wy * s),
  };
}

// ── PixiJS Setup ─────────────────────────────────────────────────────────────
function initPixiApp() {
  const container = document.getElementById('mapContainer');
  container.innerHTML = `
    <div class="map-wrapper" id="mapWrapper">
      <div class="map-toolbar">
        <button class="btn btn-ghost map-toolbar-btn" onclick="refreshMapMarkers()" title="Refresh markers">↻ Refresh</button>
        <span class="map-toolbar-info" id="mapMarkerCount"></span>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
          <button class="btn btn-ghost map-toolbar-btn" id="mapDrawToggle" onclick="toggleDrawMode()">Draw</button>
          <button class="btn btn-ghost map-toolbar-btn" id="mapEraseToggle" onclick="toggleEraseMode()">Eraser</button>
          <input type="color" id="mapDrawColor" value="${_drawColor}" onchange="_drawColor=this.value" title="Draw color" style="width:28px;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer" />
          <input type="range" id="mapBrushSize" min="1" max="20" value="${_drawWidth}" oninput="_drawWidth=Number(this.value)" title="Brush size" style="width:80px;cursor:pointer" />
        </div>
      </div>
      <div class="map-viewport" id="mapViewport">
        <div id="mapPixiContainer"></div>
        <div id="vendingPopupOverlay" style="position:absolute;inset:0;pointer-events:none;z-index:10"></div>
      </div>
    </div>`;

  const viewport = document.getElementById('mapViewport');
  const pixiContainer = document.getElementById('mapPixiContainer');

  _pixiApp = new PIXI.Application({
    background: 0x111117,
    resizeTo: viewport,
    antialias: true,
  });
  pixiContainer.appendChild(_pixiApp.view);
  _pixiApp.view.style.display = 'block';

  _mapContainer = new PIXI.Container();
  _pixiApp.stage.addChild(_mapContainer);

  _markersContainer = new PIXI.Container();

  _brushCursor = new PIXI.Graphics();
  _brushCursor.visible = false;
  _pixiApp.stage.addChild(_brushCursor);

  setupPanZoom();
}

// ── Map Image Loading ────────────────────────────────────────────────────────
async function loadMapImage() {
  const res = await fetch('/api/map');
  if (!res.ok) throw new Error('Failed to fetch map');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  // Load image into an HTMLImageElement first, then create texture
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  const texture = PIXI.Texture.from(img);
  _mapSprite = new PIXI.Sprite(texture);
  _mapContainer.addChild(_mapSprite);

  // Create offscreen canvas for painting, same size as map image
  const mapW = _mapSprite.texture.width;
  const mapH = _mapSprite.texture.height;
  _drawCanvas = document.createElement('canvas');
  _drawCanvas.width = mapW;
  _drawCanvas.height = mapH;
  _drawCtx = _drawCanvas.getContext('2d');

  _drawTexture = PIXI.Texture.from(_drawCanvas);
  _drawSprite = new PIXI.Sprite(_drawTexture);
  _mapContainer.addChild(_drawSprite);
  _mapContainer.addChild(_markersContainer);

  loadDrawingCanvas();

  // Fit to viewport
  const vw = _pixiApp.screen.width;
  const vh = _pixiApp.screen.height;
  const fitScale = Math.min(vw / _mapSprite.width, vh / _mapSprite.height);
  _mapContainer.scale.set(fitScale);
  _mapContainer.position.set(
    (vw - _mapSprite.width * fitScale) / 2,
    (vh - _mapSprite.height * fitScale) / 2,
  );

  _mapLoaded = true;
  loadDrawings();
}

// ── Pan / Zoom ───────────────────────────────────────────────────────────────
function setupPanZoom() {
  const canvas = _pixiApp.view;
  let isPanning = false;
  let startX, startY, startPosX, startPosY;
  let hasMoved = false;

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (_drawMode || _eraseMode) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const oldScale = _mapContainer.scale.x;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.min(Math.max(oldScale * factor, 0.05), 20);

    // Zoom toward mouse
    const worldX = (mx - _mapContainer.position.x) / oldScale;
    const worldY = (my - _mapContainer.position.y) / oldScale;
    _mapContainer.scale.set(newScale);
    _mapContainer.position.set(
      mx - worldX * newScale,
      my - worldY * newScale,
    );
  }, { passive: false });

  canvas.addEventListener('pointerleave', () => {
    if (_brushCursor) _brushCursor.visible = false;
  });

  canvas.addEventListener('pointerenter', (e) => {
    if (_drawMode || _eraseMode) updateBrushCursor(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (_drawMode) {
      updateBrushCursor(e.clientX, e.clientY);
      startDrawStroke(e);
      return;
    }
    if (_eraseMode) {
      updateBrushCursor(e.clientX, e.clientY);
      eraseAtPoint(e);
      return;
    }
    isPanning = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    startPosX = _mapContainer.position.x;
    startPosY = _mapContainer.position.y;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('pointermove', (e) => {
    if (_drawMode || _eraseMode) {
      updateBrushCursor(e.clientX, e.clientY);
      if (_penDown) {
        continueDrawStroke(e);
        return;
      }
      return;
    }
    if (!isPanning) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) hasMoved = true;
    _mapContainer.position.set(startPosX + dx, startPosY + dy);
  });

  window.addEventListener('pointerup', (e) => {
    if ((_drawMode || _eraseMode) && _penDown) {
      endDrawStroke(e);
      return;
    }
    isPanning = false;
    updateDrawCursor();
  });

  // Touch pinch zoom
  let lastTouchDist = 0;
  let lastTouchCenter = null;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && !_drawMode) {
      isPanning = false;
      lastTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      lastTouchCenter = {
        x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && !_drawMode) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
      if (lastTouchDist > 0) {
        const rect = canvas.getBoundingClientRect();
        const cx = lastTouchCenter.x - rect.left;
        const cy = lastTouchCenter.y - rect.top;
        const oldScale = _mapContainer.scale.x;
        const newScale = Math.min(Math.max(oldScale * (dist / lastTouchDist), 0.05), 20);
        const worldX = (cx - _mapContainer.position.x) / oldScale;
        const worldY = (cy - _mapContainer.position.y) / oldScale;
        _mapContainer.scale.set(newScale);
        _mapContainer.position.set(cx - worldX * newScale, cy - worldY * newScale);
      }
      lastTouchDist = dist;
    }
  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    lastTouchDist = 0;
    lastTouchCenter = null;
  });
}

// ── Marker Rendering ─────────────────────────────────────────────────────────
function renderMarkers() {
  _markersContainer.removeChildren();
  if (!_mapMarkers || !_mapMeta) return;

  const countEl = document.getElementById('mapMarkerCount');
  let count = 0;

  for (let i = 0; i < _mapMarkers.length; i++) {
    const m = _mapMarkers[i];
    const info = MARKER_TYPES[m.type] || { label: 'Unknown', color: 0x888888 };
    const pos = worldToPixel(m.x, m.y);

    if (m.type === 7) {
      // Radius marker
      const imgW = _mapSprite.texture.width;
      const margin = _mapMeta.oceanMargin || 0;
      const mapSize = _mapMeta.mapSize || 1;
      const s = (imgW - 2 * margin) / mapSize;
      const r = m.radius * s;
      const circle = new PIXI.Graphics();
      circle.beginFill(info.color, 0.12);
      circle.lineStyle(1, info.color, 0.3);
      circle.drawCircle(0, 0, r);
      circle.endFill();
      circle.position.set(pos.x, pos.y);
      _markersContainer.addChild(circle);
      continue;
    }

    const isVending = m.type === 3;
    const dotSize = isVending ? 6 : 4;
    const name = m.name || info.label;

    // Marker container
    const markerC = new PIXI.Container();
    markerC.position.set(pos.x, pos.y);

    // Dot
    const dot = new PIXI.Graphics();
    dot.beginFill(info.color);
    dot.lineStyle(1, 0xffffff, 0.4);
    dot.drawCircle(0, 0, dotSize);
    dot.endFill();
    markerC.addChild(dot);

    // Label
    const label = new PIXI.Text(name + (m.outOfStock ? ' (Sold Out)' : ''), {
      fontSize: 11,
      fontFamily: 'Segoe UI, system-ui, sans-serif',
      fill: 0xffffff,
      fontWeight: '600',
      dropShadow: true,
      dropShadowColor: 0x000000,
      dropShadowBlur: 3,
      dropShadowDistance: 0,
    });
    label.anchor.set(0, 0.5);
    label.position.set(dotSize + 4, 0);
    label.visible = false;
    markerC.addChild(label);

    // Interaction
    markerC.interactive = true;
    markerC.cursor = isVending ? 'pointer' : 'default';
    markerC.hitArea = new PIXI.Circle(0, 0, Math.max(dotSize + 4, 10));

    markerC.on('pointerover', () => { label.visible = true; });
    markerC.on('pointerout', () => { label.visible = false; });

    if (isVending && m.sellOrders && m.sellOrders.length > 0) {
      const markerData = m;
      markerC.on('pointertap', (e) => {
        const global = _pixiApp.view.getBoundingClientRect();
        const sx = e.global.x;
        const sy = e.global.y;
        showVendingPopup(markerData, sx, sy);
      });
    }

    _markersContainer.addChild(markerC);
    count++;
  }

  if (countEl) countEl.textContent = `${count} marker${count !== 1 ? 's' : ''}`;
}

// ── Vending Popup ────────────────────────────────────────────────────────────
function showVendingPopup(m, screenX, screenY) {
  closeVendingPopup();

  const overlay = document.getElementById('vendingPopupOverlay');
  if (!overlay) return;

  const name = m.name || 'Vending Machine';
  const orders = m.sellOrders || [];

  let itemsHtml = '';
  for (const order of orders) {
    const sellName = getItemName(order.itemId);
    const sellShort = getItemShortname(order.itemId);
    const costName = getItemName(order.currencyId);
    const costShort = getItemShortname(order.currencyId);
    const soldOut = (order.amountInStock || 0) <= 0;
    const bpBadge = order.itemIsBlueprint ? '<span class="item-bp">BP</span> ' : '';

    itemsHtml += `
      <div class="vending-order${soldOut ? ' vending-order--soldout' : ''}">
        <div class="vending-order-sell">
          ${itemIconHTML(sellShort, 28)}
          <div>
            <div class="vending-order-name">${bpBadge}${escHtml(sellName)}</div>
            <div class="vending-order-qty">x${order.quantity || 0}</div>
          </div>
        </div>
        <div class="vending-order-arrow">&rarr;</div>
        <div class="vending-order-cost">
          ${itemIconHTML(costShort, 28)}
          <div>
            <div class="vending-order-name">${escHtml(costName)}</div>
            <div class="vending-order-qty">x${order.costPerItem || 0}</div>
          </div>
        </div>
        <div class="vending-order-stock">${soldOut ? '<span style="color:var(--red)">Sold out</span>' : `${order.amountInStock} in stock`}</div>
      </div>`;
  }

  const popup = document.createElement('div');
  popup.id = 'vendingPopup';
  popup.className = 'vending-popup';
  popup.style.pointerEvents = 'auto';
  popup.innerHTML = `
    <div class="vending-popup-header">
      <span class="vending-popup-name">${escHtml(name)}</span>
      <button class="vending-popup-close" onclick="closeVendingPopup()">&#x2715;</button>
    </div>
    <div class="vending-popup-orders">${itemsHtml || '<div style="color:var(--text-muted);padding:8px">No items listed</div>'}</div>`;

  // Position near click
  const viewportRect = document.getElementById('mapViewport').getBoundingClientRect();
  let left = screenX;
  let top = screenY - 10;

  popup.style.position = 'absolute';
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
  popup.style.transform = 'translateY(-100%)';

  overlay.appendChild(popup);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    const vr = viewportRect;
    if (pr.right > vr.right) popup.style.left = (left - pr.width) + 'px';
    if (pr.top < vr.top) {
      popup.style.top = (screenY + 10) + 'px';
      popup.style.transform = 'none';
    }
  });
}

function closeVendingPopup() {
  const el = document.getElementById('vendingPopup');
  if (el) el.remove();
}

// ── Drawing Mode ─────────────────────────────────────────────────────────────
function updateDrawCursor() {
  if (!_pixiApp) return;
  const active = _drawMode || _eraseMode;
  _pixiApp.view.style.cursor = active ? 'none' : 'grab';
  if (_brushCursor) _brushCursor.visible = active;
}

function updateBrushCursor(screenX, screenY) {
  if (!_brushCursor || (!_drawMode && !_eraseMode)) return;
  const rect = _pixiApp.view.getBoundingClientRect();
  const cx = screenX - rect.left;
  const cy = screenY - rect.top;
  // Radius in screen pixels = world radius * zoom scale
  const worldR = brushWorldSize();
  const screenR = worldR * _mapContainer.scale.x;

  _brushCursor.clear();
  _brushCursor.lineStyle(1, _eraseMode ? 0xffffff : hexToNum(_drawColor), 0.7);
  _brushCursor.drawCircle(0, 0, Math.max(screenR, 2));
  _brushCursor.position.set(cx, cy);
  _brushCursor.visible = true;
}

function toggleDrawMode() {
  _drawMode = !_drawMode;
  if (_drawMode) _eraseMode = false;
  document.getElementById('mapDrawToggle')?.classList.toggle('active', _drawMode);
  document.getElementById('mapEraseToggle')?.classList.toggle('active', _eraseMode);
  updateDrawCursor();
}

function toggleEraseMode() {
  _eraseMode = !_eraseMode;
  if (_eraseMode) _drawMode = false;
  document.getElementById('mapEraseToggle')?.classList.toggle('active', _eraseMode);
  document.getElementById('mapDrawToggle')?.classList.toggle('active', _drawMode);
  updateDrawCursor();
}

function screenToWorld(sx, sy) {
  const rect = _pixiApp.view.getBoundingClientRect();
  const cx = sx - rect.left;
  const cy = sy - rect.top;
  return {
    x: (cx - _mapContainer.position.x) / _mapContainer.scale.x,
    y: (cy - _mapContainer.position.y) / _mapContainer.scale.y,
  };
}

function brushWorldSize() {
  return _drawWidth / _mapContainer.scale.x;
}

function paintAt(x, y) {
  if (!_drawCtx) return;
  const r = brushWorldSize();
  if (_eraseMode) {
    _drawCtx.save();
    _drawCtx.globalCompositeOperation = 'destination-out';
    _drawCtx.beginPath();
    _drawCtx.arc(x, y, r, 0, Math.PI * 2);
    _drawCtx.fill();
    _drawCtx.restore();
  } else {
    _drawCtx.fillStyle = _drawColor;
    _drawCtx.globalAlpha = 0.85;
    _drawCtx.beginPath();
    _drawCtx.arc(x, y, r, 0, Math.PI * 2);
    _drawCtx.fill();
    _drawCtx.globalAlpha = 1;
  }
  _drawDirty = true;
}

function paintLine(x0, y0, x1, y1) {
  if (!_drawCtx) return;
  const r = brushWorldSize();
  if (_eraseMode) {
    _drawCtx.save();
    _drawCtx.globalCompositeOperation = 'destination-out';
    _drawCtx.lineWidth = r * 2;
    _drawCtx.lineCap = 'round';
    _drawCtx.lineJoin = 'round';
    _drawCtx.beginPath();
    _drawCtx.moveTo(x0, y0);
    _drawCtx.lineTo(x1, y1);
    _drawCtx.stroke();
    _drawCtx.restore();
  } else {
    _drawCtx.strokeStyle = _drawColor;
    _drawCtx.globalAlpha = 0.85;
    _drawCtx.lineWidth = r * 2;
    _drawCtx.lineCap = 'round';
    _drawCtx.lineJoin = 'round';
    _drawCtx.beginPath();
    _drawCtx.moveTo(x0, y0);
    _drawCtx.lineTo(x1, y1);
    _drawCtx.stroke();
    _drawCtx.globalAlpha = 1;
  }
  _drawDirty = true;
}

function updateDrawTexture() {
  if (_drawTexture && _drawDirty) {
    _drawTexture.update();
    _drawDirty = false;
  }
}

function startDrawStroke(e) {
  _penDown = true;
  const p = screenToWorld(e.clientX, e.clientY);
  _lastDrawPt = p;
  paintAt(p.x, p.y);
  updateDrawTexture();
}

function continueDrawStroke(e) {
  if (!_penDown) return;
  const p = screenToWorld(e.clientX, e.clientY);
  if (_lastDrawPt) {
    paintLine(_lastDrawPt.x, _lastDrawPt.y, p.x, p.y);
  }
  _lastDrawPt = p;
  updateDrawTexture();
}

function endDrawStroke(e) {
  if (!_penDown) return;
  _penDown = false;
  _lastDrawPt = null;
  updateDrawTexture();
  scheduleCanvasSave();
}

function eraseAtPoint(e) {
  // Eraser uses the same pen flow as draw
  _penDown = true;
  const p = screenToWorld(e.clientX, e.clientY);
  _lastDrawPt = p;
  paintAt(p.x, p.y);
  updateDrawTexture();
}

function scheduleCanvasSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveDrawingCanvas, 2000);
}

function saveDrawingCanvas() {
  if (!_drawCanvas) return;
  try {
    const dataUrl = _drawCanvas.toDataURL('image/png');
    localStorage.setItem('mapDrawingCanvas', dataUrl);
  } catch (e) {
    console.warn('Failed to save drawing canvas:', e.message);
  }
}

function loadDrawingCanvas() {
  if (!_drawCanvas || !_drawCtx) return;
  const dataUrl = localStorage.getItem('mapDrawingCanvas');
  if (!dataUrl) return;
  const img = new Image();
  img.onload = () => {
    _drawCtx.drawImage(img, 0, 0);
    if (_drawTexture) _drawTexture.update();
  };
  img.src = dataUrl;
}

function clearDrawings() {
  if (_drawCtx && _drawCanvas) {
    _drawCtx.clearRect(0, 0, _drawCanvas.width, _drawCanvas.height);
    if (_drawTexture) _drawTexture.update();
  }
  localStorage.removeItem('mapDrawingCanvas');
}

// ── Public API ───────────────────────────────────────────────────────────────
async function loadMap() {
  const container = document.getElementById('mapContainer');
  if (state.status !== 'connected') {
    destroyMap();
    container.innerHTML = '<div class="empty-state"><div class="icon">🗺️</div><h3>Not connected</h3><p>Connect to a server to view the map.</p></div>';
    return;
  }

  try {
    if (!_pixiApp) {
      container.innerHTML = '<div class="empty-state"><div class="icon">🗺️</div><h3>Loading map...</h3><p>Fetching map data from server.</p></div>';
      // Init PixiJS app first (sets up DOM structure)
      await initPixiApp();
      // Then load image + data in parallel
      const [, markersRes, metaRes] = await Promise.all([
        loadMapImage(),
        api('GET', '/api/map/markers'),
        api('GET', '/api/map/meta'),
      ]);
      _mapMeta = metaRes;
      _mapMarkers = markersRes.markers || [];
    } else {
      // Already loaded, just refresh markers
      const [markersRes, metaRes] = await Promise.all([
        api('GET', '/api/map/markers'),
        api('GET', '/api/map/meta'),
      ]);
      _mapMeta = metaRes;
      _mapMarkers = markersRes.markers || [];
    }
    renderMarkers();
  } catch (e) {
    if (!_mapLoaded) {
      destroyMap();
      container.innerHTML = `<div class="empty-state"><div class="icon">🗺️</div><h3>Failed to load map</h3><p>${escHtml(e.message)}</p></div>`;
    }
    console.error('Map load error:', e, e?.stack);
  }
}

async function refreshMapMarkers() {
  try {
    const res = await api('GET', '/api/map/markers');
    _mapMarkers = res.markers || [];
    renderMarkers();
  } catch (e) {
    console.error('Failed to refresh markers:', e);
  }
}

function destroyMap() {
  closeVendingPopup();
  clearTimeout(_saveTimer);
  if (_drawCanvas && _drawCtx) saveDrawingCanvas();
  if (_pixiApp) {
    _pixiApp.destroy(true, { children: true, texture: true, baseTexture: true });
    _pixiApp = null;
  }
  _mapContainer = null;
  _mapSprite = null;
  _markersContainer = null;
  _drawCanvas = null;
  _drawCtx = null;
  _drawSprite = null;
  _drawTexture = null;
  _mapLoaded = false;
  _mapMarkers = null;
  _mapMeta = null;
  _drawMode = false;
  _eraseMode = false;
  _penDown = false;
  _lastDrawPt = null;
  _drawDirty = false;
  _brushCursor = null;
}
