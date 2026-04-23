// ── PixiJS Map Module ─────────────────────────────────────────────────────────
// Self-contained map rendering with PixiJS. Exposes: loadMap(), refreshMapMarkers()

let _pixiApp = null;
let _mapContainer = null;
let _mapSprite = null;
let _markersContainer = null;
// Static markers (vending, crates, radii) are wiped and rebuilt every render.
// Moving markers (players, helis, chinooks, cargo) live across renders so we
// can interpolate their position from the previous tick to the next.
let _staticMarkersContainer = null;
let _movingMarkersContainer = null;
const _movingMarkers = new Map(); // `${type}_${id}` -> PIXI.Container
const _markerTweens = new Map();  // same key -> { fromX, fromY, toX, toY, startTime, duration }
const MOVING_TYPES = new Set(["Player", "PatrolHelicopter", "CH47", "CargoShip"]);
// When set, the camera recenters on this marker every frame.
let _followingKey = null;
let _followingLabel = "";
// Drawing layer lives entirely on the GPU. CPU only ships a few floats of
// stroke geometry per pointer event; never any pixel data during drawing.
let _drawRenderTexture = null; // GPU-only canvas for committed paint
let _drawSprite = null; // PIXI.Sprite displaying the RenderTexture
let _mapLoaded = false;
let _mapMarkers = null;
let _mapMeta = null;
let _teamNotes = []; // player-placed map markers from getTeamInfo
let _itemSearchQuery = ""; // lowercased; when non-empty, only matching vendings render
let _drawMode = false;
let _eraseMode = false;
let _penDown = false;
let _lastDrawPt = null;
let _drawColor = "#000000";
let _drawWidth = 10;
let _drawDirty = false;
let _saveTimer = null;
let _brushCursor = null;
let _vendingPopupMarker = null;
// Track pending saves so a broadcast we triggered ourselves doesn't cause us
// to round-trip our own drawing back through the texture.
const _pendingSaveIds = new Set();
// Pre-rendered soft radial-gradient brush, built lazily and reused for every
// stamp. Tinted per-stroke; eraser uses ERASE blend mode.
let _brushTexture = null;
// Steam profile cache: steamId -> { name, avatar, avatarFull, ... } or
// `null` for a known-failed lookup (so we don't retry on every marker refresh).
const _steamProfiles = new Map();
const _steamInflight = new Map(); // steamId -> Promise<profile|null>

// Vending-machine item search. Matches against both the item being sold and
// the currency it's bought with, so e.g. typing "scrap" surfaces both "buys X
// for scrap" and "sells scrap for Y" listings. Results are shown in a panel
// over the map; clicking a row centres the camera on that vending machine.
function setItemSearch(q) {
  _itemSearchQuery = (q || "").trim().toLowerCase();
  _renderSearchResults();
}

function _vendingMatches(m, query) {
  if (!query || !m.sellOrders || m.sellOrders.length === 0) return null;
  const matches = [];
  for (const o of m.sellOrders) {
    const sellName = (typeof getItemName === "function" ? getItemName(o.itemId) : "").toLowerCase();
    const costName = (typeof getItemName === "function" ? getItemName(o.currencyId) : "").toLowerCase();
    const sellMatch = sellName.includes(query);
    const costMatch = costName.includes(query);
    if (sellMatch || costMatch) matches.push({ order: o, asSell: sellMatch, asCost: costMatch });
  }
  return matches.length > 0 ? matches : null;
}

// Centre the camera on a world position at the current zoom (no follow lock).
function flyToWorld(wx, wy) {
  if (!_pixiApp || !_mapContainer) return;
  clearFollow();
  const pos = worldToPixel(wx, wy);
  const scale = _mapContainer.scale.x;
  _mapContainer.position.set(
    _pixiApp.screen.width / 2 - pos.x * scale,
    _pixiApp.screen.height / 2 - pos.y * scale,
  );
}

function _escHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function _renderSearchResults() {
  const panel = document.getElementById("mapSearchResults");
  if (!panel) return;
  const q = _itemSearchQuery;
  if (!q) {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }

  // Flatten: one row per matched sell order across all vending machines
  const rows = [];
  for (const m of (_mapMarkers || [])) {
    if (m.type !== "VendingMachine") continue;
    const matches = _vendingMatches(m, q);
    if (!matches) continue;
    for (const { order, asSell } of matches) {
      const stock = order.amountInStock || 0;
      rows.push({
        vendingName: m.name || "Vending Machine",
        x: m.x,
        y: m.y,
        sellName: getItemName(order.itemId),
        sellQty: order.quantity || 0,
        costName: getItemName(order.currencyId),
        costPer: order.costPerItem || 0,
        stock,
        asSell,
        soldOut: stock <= 0,
        outOfStock: !!m.outOfStock,
      });
    }
  }

  if (rows.length === 0) {
    panel.innerHTML = `<div class="map-search-empty">No vending listings match <b>${_escHtml(q)}</b></div>`;
    panel.style.display = "";
    return;
  }

  // Sort: in-stock first, then by lowest unit price for the matched item
  rows.sort((a, b) => {
    if (a.soldOut !== b.soldOut) return a.soldOut ? 1 : -1;
    return a.costPer / Math.max(a.sellQty, 1) - b.costPer / Math.max(b.sellQty, 1);
  });

  const header = `<div class="map-search-header">
    <span><b>${rows.length}</b> listing${rows.length !== 1 ? "s" : ""} match <b>${_escHtml(q)}</b></span>
    <button class="map-search-close" onclick="setItemSearch('');document.getElementById('mapItemSearch').value='';" title="Close">✕</button>
  </div>`;

  const body = rows.map((r, i) => {
    const tag = r.asSell
      ? `<span class="map-search-tag map-search-tag--sells">SELLS</span>`
      : `<span class="map-search-tag map-search-tag--buys">BUYS WITH</span>`;
    const soldOut = r.soldOut ? `<span class="map-search-soldout">Sold out</span>` : `<span class="map-search-stock">${r.stock} in stock</span>`;
    return `<div class="map-search-row" onclick="flyToWorld(${r.x}, ${r.y})">
      <div class="map-search-row-main">
        ${tag}
        <span class="map-search-item">${r.sellQty}× ${_escHtml(r.sellName)}</span>
        <span class="map-search-arrow">←</span>
        <span class="map-search-cost">${r.costPer}× ${_escHtml(r.costName)}</span>
      </div>
      <div class="map-search-row-sub">
        <span class="map-search-vending">${_escHtml(r.vendingName)}</span>
        ${soldOut}
      </div>
    </div>`;
  }).join("");

  panel.innerHTML = header + `<div class="map-search-list">${body}</div>`;
  panel.style.display = "";
}

function getSteamProfile(steamId) {
  if (!steamId) return Promise.resolve(null);
  if (_steamProfiles.has(steamId))
    return Promise.resolve(_steamProfiles.get(steamId));
  if (_steamInflight.has(steamId)) return _steamInflight.get(steamId);
  const p = fetch(`/api/steam/profile/${steamId}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((profile) => {
      _steamProfiles.set(steamId, profile);
      _steamInflight.delete(steamId);
      return profile;
    })
    .catch(() => {
      _steamProfiles.set(steamId, null);
      _steamInflight.delete(steamId);
      return null;
    });
  _steamInflight.set(steamId, p);
  return p;
}

// Keys are proto enum names — protobufjs's default toJSON serializes enums as
// their string names, not integers, so `m.type` arrives as e.g. "Player".
const MARKER_TYPES = {
  Player: { label: "Player", color: 0x4ade80 },
  Explosion: { label: "Explosion", color: 0xf87171 },
  VendingMachine: { label: "Vending Machine", color: 0x60a5fa },
  CH47: { label: "CH47", color: 0xfacc15 },
  CargoShip: { label: "Cargo Ship", color: 0xf97316 },
  Crate: { label: "Crate", color: 0xa78bfa },
  GenericRadius: { label: "Radius", color: 0xfacc15 },
  PatrolHelicopter: { label: "Attack Helicopter", color: 0xef4444 },
};

function hexToNum(hex) {
  return parseInt(hex.replace("#", ""), 16);
}

// Logarithmic brush slider: position 0..1000 ↔ size 1..200 world pixels.
// More granularity at the small end (where sub-10px sizes matter most).
const _BRUSH_MIN = 1;
const _BRUSH_MAX = 200;
function sliderToBrushSize(pos) {
  const t = Math.min(Math.max(pos, 0), 1000) / 1000;
  return Math.round(
    Math.exp(
      Math.log(_BRUSH_MIN) + t * (Math.log(_BRUSH_MAX) - Math.log(_BRUSH_MIN)),
    ),
  );
}
function brushSizeToSlider(size) {
  const s = Math.min(Math.max(size, _BRUSH_MIN), _BRUSH_MAX);
  return Math.round(
    ((Math.log(s) - Math.log(_BRUSH_MIN)) /
      (Math.log(_BRUSH_MAX) - Math.log(_BRUSH_MIN))) *
      1000,
  );
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
  const container = document.getElementById("mapContainer");
  container.innerHTML = `
    <div class="map-wrapper" id="mapWrapper">
      <div class="map-viewport" id="mapViewport">
        <div id="mapPixiContainer"></div>
        <div class="map-toolbar map-toolbar--overlay map-toolbar--left">
          <button class="btn btn-ghost map-toolbar-btn" onclick="refreshMapMarkers()" title="Refresh markers">↻</button>
          <span class="map-toolbar-info" id="mapMarkerCount"></span>
          <input type="text" id="mapItemSearch" placeholder="Find vending item…" value="${_itemSearchQuery}" oninput="setItemSearch(this.value)" style="margin-left:6px;padding:4px 8px;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:0.82rem;width:180px" />
        </div>
        <div class="map-search-results" id="mapSearchResults" style="display:none"></div>
        <div class="map-follow-banner" id="mapFollowBanner" style="display:none">
          <span class="map-follow-icon">🎯</span>
          <span>Following <span class="map-follow-name"></span></span>
          <button class="map-follow-close" onclick="clearFollow()" title="Stop following">✕</button>
        </div>
        <div class="map-toolbar map-toolbar--overlay map-toolbar--right">
          <button class="btn btn-ghost map-toolbar-btn" id="mapDrawToggle" onclick="toggleDrawMode()">Draw</button>
          <button class="btn btn-ghost map-toolbar-btn" id="mapEraseToggle" onclick="toggleEraseMode()">Eraser</button>
          <input type="color" id="mapDrawColor" value="${_drawColor}" onchange="_drawColor=this.value" title="Draw color" style="width:28px;height:28px;padding:0;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer" />
          <input type="range" id="mapBrushSize" min="0" max="1000" value="${brushSizeToSlider(_drawWidth)}" oninput="_drawWidth=sliderToBrushSize(Number(this.value))" title="Brush size" style="width:200px;cursor:pointer" />
          <button class="btn btn-ghost map-toolbar-btn" id="mapFullscreenToggle" onclick="toggleMapFullscreen()" title="Toggle fullscreen">⛶</button>
        </div>
        <div id="vendingPopupOverlay" style="position:absolute;inset:0;pointer-events:none;z-index:10"></div>
      </div>
    </div>`;

  const viewport = document.getElementById("mapViewport");
  const pixiContainer = document.getElementById("mapPixiContainer");

  _pixiApp = new PIXI.Application({
    background: 0x111117,
    resizeTo: viewport,
    antialias: true,
    // Render at native device pixel density so Graphics edges (the player
    // ring, dots, etc.) and sprites are crisp on hi-DPI displays. autoDensity
    // keeps the canvas's CSS size in logical pixels so pointer math doesn't
    // need to change.
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  pixiContainer.appendChild(_pixiApp.view);
  _pixiApp.view.style.display = "block";

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
  const res = await fetch("/api/map");
  if (!res.ok) throw new Error("Failed to fetch map");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  // Load image into an HTMLImageElement first, then create texture
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  const texture = PIXI.Texture.from(img);
  _mapSprite = new PIXI.Sprite(texture);
  _mapContainer.addChild(_mapSprite);

  // GPU-resident drawing texture, same size as map image. No CPU canvas.
  const mapW = _mapSprite.texture.width;
  const mapH = _mapSprite.texture.height;
  _drawRenderTexture = PIXI.RenderTexture.create({ width: mapW, height: mapH });
  _drawSprite = new PIXI.Sprite(_drawRenderTexture);
  _mapContainer.addChild(_drawSprite);

  // Two marker layers: static is cleared/rebuilt each render; moving is
  // persistent so we can tween position smoothly between server updates.
  _staticMarkersContainer = new PIXI.Container();
  _movingMarkersContainer = new PIXI.Container();
  _markersContainer.addChild(_staticMarkersContainer);
  _markersContainer.addChild(_movingMarkersContainer);
  _mapContainer.addChild(_markersContainer);

  // Per-frame interpolation for any active marker tweens
  _pixiApp.ticker.add(_tickMarkerInterpolation);

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
}

// ── Pan / Zoom ───────────────────────────────────────────────────────────────
function setupPanZoom() {
  const canvas = _pixiApp.view;
  let isPanning = false;
  let startX, startY, startPosX, startPosY;
  let hasMoved = false;

  canvas.addEventListener(
    "wheel",
    (e) => {
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
    },
    { passive: false },
  );

  canvas.addEventListener("pointerleave", () => {
    if (_brushCursor) _brushCursor.visible = false;
  });

  canvas.addEventListener("pointerenter", (e) => {
    if (_drawMode || _eraseMode) updateBrushCursor(e.clientX, e.clientY);
  });

  canvas.addEventListener("pointerdown", (e) => {
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
    canvas.style.cursor = "grabbing";
  });

  window.addEventListener("pointermove", (e) => {
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
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      if (!hasMoved && _followingKey) clearFollow(); // user took manual control
      hasMoved = true;
    }
    _mapContainer.position.set(startPosX + dx, startPosY + dy);
  });

  window.addEventListener("pointerup", (e) => {
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

  canvas.addEventListener(
    "touchstart",
    (e) => {
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
    },
    { passive: true },
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
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
          const newScale = Math.min(
            Math.max(oldScale * (dist / lastTouchDist), 0.05),
            20,
          );
          const worldX = (cx - _mapContainer.position.x) / oldScale;
          const worldY = (cy - _mapContainer.position.y) / oldScale;
          _mapContainer.scale.set(newScale);
          _mapContainer.position.set(
            cx - worldX * newScale,
            cy - worldY * newScale,
          );
        }
        lastTouchDist = dist;
      }
    },
    { passive: false },
  );

  canvas.addEventListener("touchend", () => {
    lastTouchDist = 0;
    lastTouchCenter = null;
  });
}

// ── Marker Rendering ─────────────────────────────────────────────────────────

function _markerKey(m) {
  return `${m.type}_${m.id}`;
}

// PIXI.Text rasterizes once and then scales with its parent — so default
// resolution + map zoom = blurry. Render at 2× devicePixelRatio for a sharp
// source bitmap; the counter-scaling below keeps the displayed size constant
// so we hit close to 1:1 pixels at any zoom.
const _TEXT_RESOLUTION = (window.devicePixelRatio || 1) * 2;
function _makeMarkerText(content, opts = {}) {
  const t = new PIXI.Text(content, {
    fontSize: 11,
    fontFamily: "Segoe UI, system-ui, sans-serif",
    fill: 0xffffff,
    fontWeight: "700",
    dropShadow: true,
    dropShadowColor: 0x000000,
    dropShadowBlur: 4,
    dropShadowDistance: 0,
    ...opts,
  });
  t.resolution = _TEXT_RESOLUTION;
  return t;
}

function _tickMarkerInterpolation() {
  // Advance any active position tweens
  if (_markerTweens.size > 0) {
    const now = performance.now();
    for (const [key, tween] of _markerTweens) {
      const obj = _movingMarkers.get(key);
      if (!obj) { _markerTweens.delete(key); continue; }
      const t = Math.min(1, (now - tween.startTime) / tween.duration);
      obj.position.set(
        tween.fromX + (tween.toX - tween.fromX) * t,
        tween.fromY + (tween.toY - tween.fromY) * t,
      );
      if (t >= 1) _markerTweens.delete(key);
    }
  }

  // Counter-scale opted-in markers so their on-screen size is constant
  // regardless of map zoom. Markers without `_screenScale` (e.g. radius
  // circles) keep their world-space size.
  if (_mapContainer && _staticMarkersContainer && _movingMarkersContainer) {
    const invScale = 1 / _mapContainer.scale.x;
    for (const c of _movingMarkers.values()) c.scale.set(invScale);
    for (const c of _staticMarkersContainer.children) {
      if (c._screenScale) c.scale.set(invScale);
    }
  }

  // Camera-follow: keep the followed marker centered in the viewport
  if (_followingKey && _mapContainer && _pixiApp) {
    const obj = _movingMarkers.get(_followingKey);
    if (!obj) {
      // The followed marker disappeared (e.g. player went offline) — release
      clearFollow();
      return;
    }
    const scale = _mapContainer.scale.x;
    const vw = _pixiApp.screen.width;
    const vh = _pixiApp.screen.height;
    _mapContainer.position.set(
      vw / 2 - obj.position.x * scale,
      vh / 2 - obj.position.y * scale,
    );
  }
}

function setFollow(key, label) {
  _followingKey = key;
  _followingLabel = label || "";
  _updateFollowBanner();
}

function clearFollow() {
  _followingKey = null;
  _followingLabel = "";
  _updateFollowBanner();
}

function _updateFollowBanner() {
  const el = document.getElementById("mapFollowBanner");
  if (!el) return;
  if (_followingKey) {
    el.style.display = "";
    el.querySelector(".map-follow-name").textContent = _followingLabel;
  } else {
    el.style.display = "none";
  }
}

// Player-placed team map note. Rust+ exposes:
//   - type (2):         0 = death marker, 1 = user-placed pin
//   - icon (5):         0..11 — the icon picker in the in-game editor
//   - colourIndex (6):  0..5  — the colour picker
//   - label (7):        user-entered text
// Wire indexes follow the editor's visual order. 0 = yellow (the default).
const TEAM_NOTE_COLORS = [
  0xeab308, // 0 yellow (default)
  0x3b82f6, // 1 blue
  0x22c55e, // 2 green
  0xef4444, // 3 red
  0xa855f7, // 4 purple
  0x14b8a6, // 5 teal
];

// Multiply each RGB channel by `factor` (0=black, 1=identity, >1=brighter).
// Used to derive the darker icon-silhouette tone from the selected disc color.
function shadeColor(color, factor) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
  return (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);
}
// Hand-drawn icon silhouettes. Each takes `(g, dark, light)` — `dark` is the
// silhouette colour (a darker shade of the team colour) and `light` is the
// disc fill (used for cutouts/details so the icon stays 2-tone within the
// chosen colour). Geometry is centred on (0, 0) and stays within ±9 px.
const TEAM_NOTE_ICON_DRAWERS = [
  // 0 — pin / location
  (g, dark, light) => {
    g.beginFill(dark);
    g.moveTo(0, 8);
    g.bezierCurveTo(-7, 1, -7, -5, 0, -8);
    g.bezierCurveTo(7, -5, 7, 1, 0, 8);
    g.endFill();
    g.beginFill(light);
    g.drawCircle(0, -3, 2.4);
    g.endFill();
  },
  // 1 — dollar
  (g, dark) => {
    g.lineStyle(1.6, dark);
    g.moveTo(0, -9); g.lineTo(0, 9);
    g.beginFill(0, 0);
    g.moveTo(5, -5);
    g.bezierCurveTo(5, -8, -5, -8, -5, -5);
    g.bezierCurveTo(-5, -2, 5, -2, 5, 1);
    g.bezierCurveTo(5, 4, -5, 4, -5, 1);
    g.endFill();
    g.lineStyle(0);
  },
  // 2 — house
  (g, dark, light) => {
    g.beginFill(dark);
    g.moveTo(0, -8); g.lineTo(-8, -1); g.lineTo(8, -1); g.closePath();
    g.drawRect(-6, -1, 12, 8);
    g.endFill();
    g.beginFill(light);
    g.drawRect(-1.5, 2, 3, 5);
    g.endFill();
  },
  // 3 — parachute
  (g, dark, light) => {
    g.beginFill(dark);
    g.arc(0, -1, 8, Math.PI, 0, false);
    g.lineTo(8, -1); g.lineTo(-8, -1); g.closePath();
    g.endFill();
    // Canopy panel divisions
    g.beginFill(light, 0.6);
    g.moveTo(-3, -1); g.lineTo(0, -8); g.lineTo(-1.5, -1); g.closePath();
    g.moveTo(3, -1);  g.lineTo(0, -8); g.lineTo(1.5, -1); g.closePath();
    g.endFill();
    g.lineStyle(1, dark);
    g.moveTo(-7, -1); g.lineTo(0, 6);
    g.moveTo(-3, -1); g.lineTo(0, 6);
    g.moveTo(3, -1);  g.lineTo(0, 6);
    g.moveTo(7, -1);  g.lineTo(0, 6);
    g.lineStyle(0);
    g.beginFill(dark);
    g.drawCircle(0, 7, 1.5);
    g.endFill();
  },
  // 4 — target / crosshair
  (g, dark) => {
    g.lineStyle(1.4, dark);
    g.beginFill(0, 0);
    g.drawCircle(0, 0, 7);
    g.drawCircle(0, 0, 4);
    g.endFill();
    g.lineStyle(0);
    g.beginFill(dark);
    g.drawCircle(0, 0, 1.5);
    g.endFill();
    g.lineStyle(1.4, dark);
    g.moveTo(-9, 0); g.lineTo(-7, 0);
    g.moveTo(7, 0);  g.lineTo(9, 0);
    g.moveTo(0, -9); g.lineTo(0, -7);
    g.moveTo(0, 7);  g.lineTo(0, 9);
    g.lineStyle(0);
  },
  // 5 — shield
  (g, dark) => {
    g.beginFill(dark);
    g.moveTo(0, -8);
    g.lineTo(7, -6);
    g.lineTo(7, 1);
    g.bezierCurveTo(7, 5, 4, 7, 0, 8);
    g.bezierCurveTo(-4, 7, -7, 5, -7, 1);
    g.lineTo(-7, -6);
    g.closePath();
    g.endFill();
  },
  // 6 — skull
  (g, dark, light) => {
    g.beginFill(dark);
    g.drawCircle(0, -2, 6);
    g.drawRoundedRect(-3.5, 3, 7, 4, 1);
    g.endFill();
    g.beginFill(light);
    g.drawCircle(-2.4, -2, 1.4);
    g.drawCircle(2.4, -2, 1.4);
    g.drawRect(-0.7, 0, 1.4, 1.6);
    g.drawRect(-2.4, 4, 1.2, 2);
    g.drawRect(-0.6, 4, 1.2, 2);
    g.drawRect(1.2, 4, 1.2, 2);
    g.endFill();
  },
  // 7 — bed
  (g, dark) => {
    g.beginFill(dark);
    g.drawRect(-8, -3, 2, 8);
    g.drawRect(-6, 1, 14, 4);
    g.drawRect(-5, -2, 4, 3);
    g.drawRect(-8, 5, 2, 2);
    g.drawRect(6, 5, 2, 2);
    g.endFill();
  },
  // 8 — zzz / sleep
  (g, dark) => {
    g.lineStyle(1.4, dark);
    g.beginFill(0, 0);
    g.moveTo(-8, -4); g.lineTo(-4, -4); g.lineTo(-8, -1); g.lineTo(-4, -1);
    g.moveTo(-2, -1); g.lineTo(3, -1);  g.lineTo(-2, 4);  g.lineTo(3, 4);
    g.moveTo(4, 3);   g.lineTo(8, 3);   g.lineTo(4, 7);   g.lineTo(8, 7);
    g.lineStyle(0);
  },
  // 9 — pistol
  (g, dark, light) => {
    g.beginFill(dark);
    g.drawRoundedRect(-8, -3, 14, 4, 0.8);
    g.drawRect(2.5, -5, 1.5, 2);
    g.moveTo(-7, 1); g.lineTo(-3, 1); g.lineTo(-1.5, 8); g.lineTo(-6, 8); g.closePath();
    g.drawRoundedRect(-3, 1, 4, 3, 1);
    g.endFill();
    g.beginFill(light);
    g.drawRect(-2, 1.8, 2.5, 1.6);
    g.endFill();
  },
  // 10 — rock / boulder
  (g, dark, light) => {
    g.beginFill(dark);
    g.moveTo(-7, 2);
    g.lineTo(-8, -2);
    g.lineTo(-4, -6);
    g.lineTo(2, -7);
    g.lineTo(7, -3);
    g.lineTo(8, 3);
    g.lineTo(4, 7);
    g.lineTo(-3, 7);
    g.closePath();
    g.endFill();
    // Facet highlight using the light tone
    g.beginFill(light, 0.55);
    g.moveTo(-4, -6); g.lineTo(2, -7); g.lineTo(0, -3); g.lineTo(-3, -2); g.closePath();
    g.moveTo(2, -7);  g.lineTo(7, -3); g.lineTo(4, -1); g.lineTo(0, -3); g.closePath();
    g.endFill();
  },
  // 11 — treasure chest
  (g, dark, light) => {
    g.beginFill(dark);
    // Rounded lid
    g.moveTo(-8, 0);
    g.bezierCurveTo(-8, -8, 8, -8, 8, 0);
    g.lineTo(8, 1);
    g.lineTo(-8, 1);
    g.closePath();
    // Body
    g.drawRoundedRect(-8, 1, 16, 7, 1);
    g.endFill();
    // Lid/body separator + corner braces + lock plate using the light tone
    g.beginFill(light);
    g.drawRect(-8, 0.5, 16, 0.8);
    g.drawRect(-7, -3, 1.2, 11);
    g.drawRect(5.8, -3, 1.2, 11);
    g.drawRoundedRect(-2, -1, 4, 4, 0.6);
    g.endFill();
    // Keyhole punched back through to dark
    g.beginFill(dark);
    g.drawCircle(0, 0.5, 0.7);
    g.drawRect(-0.4, 0.5, 0.8, 1.4);
    g.endFill();
  },
];

function makeTeamNoteMarker(note) {
  const c = new PIXI.Container();
  const isDeath = (note.type ?? 0) === 0;
  const colorIdx = note.colourIndex ?? 0; // default yellow (Rust+ omits when default)
  const light = TEAM_NOTE_COLORS[colorIdx % TEAM_NOTE_COLORS.length];
  const dark = shadeColor(light, 0.42);   // ~58% darker — silhouette tone
  const rim = shadeColor(light, 0.28);    // even darker for the disc rim
  const iconIdx = isDeath ? 6 : (note.icon ?? 0); // death marker → skull
  const drawer = TEAM_NOTE_ICON_DRAWERS[iconIdx % TEAM_NOTE_ICON_DRAWERS.length];

  const radius = 13;

  // Disc — light fill + matching dark rim, all derived from the team colour
  const disc = new PIXI.Graphics();
  disc.lineStyle(1.5, rim, 1);
  disc.beginFill(light, 1);
  disc.drawCircle(0, 0, radius);
  disc.endFill();
  c.addChild(disc);

  // Icon silhouette drawn at the dark tone, with cutouts in the light tone
  // so the icon stays a true two-tone within the chosen colour.
  const iconG = new PIXI.Graphics();
  drawer(iconG, dark, light);
  c.addChild(iconG);

  if (note.label) {
    const labelText = _makeMarkerText(note.label);
    labelText.anchor.set(0.5, 0);
    labelText.position.set(0, radius + 3);
    c.addChild(labelText);
  }

  c._screenScale = true;
  c.interactive = true;
  c.cursor = "default";
  c.hitArea = new PIXI.Circle(0, 0, radius + 2);
  return c;
}

function makeMovingMarker(m) {
  let c;
  let label;
  if (m.type === "Player") {
    const profile = _steamProfiles.get(m.steamId) || null;
    label = profile?.name || m.name || "Player";
    c = makePlayerMarker(label, profile?.avatar || null);
    c._needsAvatarUpdate = !profile?.avatar;
  } else {
    // PatrolHelicopter / CH47 / CargoShip: dot + always-visible label
    const info = MARKER_TYPES[m.type] || { label: "Unknown", color: 0x888888 };
    const dotSize = 5;
    label = m.name || info.label;
    c = new PIXI.Container();
    const dot = new PIXI.Graphics();
    dot.beginFill(info.color);
    dot.lineStyle(1, 0xffffff, 0.5);
    dot.drawCircle(0, 0, dotSize);
    dot.endFill();
    c.addChild(dot);
    const text = _makeMarkerText(label);
    text.anchor.set(0.5, 0);
    text.position.set(0, dotSize + 3);
    c.addChild(text);
    c.interactive = true;
    c.hitArea = new PIXI.Circle(0, 0, Math.max(dotSize + 4, 12));
  }
  c.cursor = "pointer";
  // Click to toggle follow on this marker
  const key = _markerKey(m);
  c.on("pointertap", (e) => {
    e.stopPropagation && e.stopPropagation();
    if (_followingKey === key) clearFollow();
    else setFollow(key, label);
  });
  return c;
}

function makePlayerMarker(name, avatarUrl) {
  const container = new PIXI.Container();
  const size = 28;
  const ringColor = 0x4ade80;

  // Outer ring + dark backing in case the avatar texture hasn't resolved yet
  const ring = new PIXI.Graphics();
  ring.lineStyle(2, ringColor, 1);
  ring.beginFill(0x111117);
  ring.drawCircle(0, 0, size / 2);
  ring.endFill();
  container.addChild(ring);

  if (avatarUrl) {
    const sprite = PIXI.Sprite.from(avatarUrl);
    sprite.width = size - 2;
    sprite.height = size - 2;
    sprite.anchor.set(0.5);
    // Clip the avatar to a circle inside the ring
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff);
    mask.drawCircle(0, 0, (size - 2) / 2);
    mask.endFill();
    container.addChild(mask);
    sprite.mask = mask;
    container.addChild(sprite);
  } else {
    // No avatar yet — show solid colored dot inside the ring
    const dot = new PIXI.Graphics();
    dot.beginFill(ringColor);
    dot.drawCircle(0, 0, (size - 2) / 2);
    dot.endFill();
    container.addChild(dot);
  }

  if (name) {
    const label = _makeMarkerText(name);
    label.anchor.set(0.5, 0);
    label.position.set(0, size / 2 + 3);
    container.addChild(label);
  }

  container.interactive = true;
  container.hitArea = new PIXI.Circle(0, 0, size / 2);
  return container;
}

async function renderMarkers() {
  if (!_staticMarkersContainer || !_movingMarkersContainer || !_mapMarkers || !_mapMeta) return;

  // Pre-fetch Steam profiles so player markers come up with avatars in one shot
  const playerSteamIds = [
    ...new Set(
      _mapMarkers
        .filter((m) => m.type === "Player" && m.steamId)
        .map((m) => m.steamId),
    ),
  ];
  await Promise.all(playerSteamIds.map(getSteamProfile));
  if (!_mapMarkers || !_mapMeta) return;

  // Static markers: wipe and rebuild
  _staticMarkersContainer.removeChildren();

  const seenMovingKeys = new Set();
  let count = 0;

  for (const m of _mapMarkers) {
    const pos = worldToPixel(m.x, m.y);

    // ── Moving markers: persist container, schedule position tween ──────────
    if (MOVING_TYPES.has(m.type)) {
      const key = _markerKey(m);
      seenMovingKeys.add(key);
      let obj = _movingMarkers.get(key);

      // If we made a player marker without an avatar earlier and now have one,
      // recreate so the avatar shows up
      const haveAvatarNow = m.type === "Player" && _steamProfiles.get(m.steamId)?.avatar;
      if (obj && obj._needsAvatarUpdate && haveAvatarNow) {
        const oldX = obj.position.x;
        const oldY = obj.position.y;
        _movingMarkersContainer.removeChild(obj);
        obj.destroy({ children: true });
        obj = makeMovingMarker(m);
        obj.position.set(oldX, oldY);
        _movingMarkersContainer.addChild(obj);
        _movingMarkers.set(key, obj);
      }

      if (!obj) {
        obj = makeMovingMarker(m);
        obj.position.set(pos.x, pos.y); // first sight: drop at position, no tween
        _movingMarkersContainer.addChild(obj);
        _movingMarkers.set(key, obj);
      } else {
        // Tween from where the marker is currently displayed (which itself may
        // be mid-tween) to the new position
        _markerTweens.set(key, {
          fromX: obj.position.x,
          fromY: obj.position.y,
          toX: pos.x,
          toY: pos.y,
          startTime: performance.now(),
          // Match the refresh cadence so each tween finishes right as the
          // next data tick arrives — continuous, lag-free motion.
          duration: MARKER_REFRESH_INTERVAL_MS,
        });
      }
      count++;
      continue;
    }

    // ── Static markers ──────────────────────────────────────────────────────
    const info = MARKER_TYPES[m.type] || { label: "Unknown", color: 0x888888 };

    if (m.type === "GenericRadius") {
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
      _staticMarkersContainer.addChild(circle);
      count++;
      continue;
    }

    const isVending = m.type === "VendingMachine";
    const dotSize = isVending ? 6 : 4;
    const name = m.name || info.label;

    const markerC = new PIXI.Container();
    markerC.position.set(pos.x, pos.y);

    const dot = new PIXI.Graphics();
    dot.beginFill(info.color);
    dot.lineStyle(1, 0xffffff, 0.4);
    dot.drawCircle(0, 0, dotSize);
    dot.endFill();
    markerC.addChild(dot);

    const label = _makeMarkerText(name + (m.outOfStock ? " (Sold Out)" : ""), {
      fontWeight: "600",
      dropShadowBlur: 3,
    });
    label.anchor.set(0, 0.5);
    label.position.set(dotSize + 4, 0);
    label.visible = false;
    markerC.addChild(label);

    markerC.interactive = true;
    markerC.cursor = isVending ? "pointer" : "default";
    markerC.hitArea = new PIXI.Circle(0, 0, Math.max(dotSize + 4, 10));

    markerC.on("pointerover", () => { label.visible = true; });
    markerC.on("pointerout", () => { label.visible = false; });

    if (isVending && m.sellOrders && m.sellOrders.length > 0) {
      const markerData = m;
      markerC.on("pointertap", (e) => {
        showVendingPopup(markerData, e.global.x, e.global.y);
      });
    }

    markerC._screenScale = true;
    _staticMarkersContainer.addChild(markerC);
    count++;
  }

  // Render team-placed map notes (always static — no interpolation needed)
  for (const note of _teamNotes) {
    const pos = worldToPixel(note.x, note.y);
    const pin = makeTeamNoteMarker(note);
    pin.position.set(pos.x, pos.y);
    _staticMarkersContainer.addChild(pin);
    count++;
  }

  // Drop moving markers we no longer see
  for (const [key, obj] of _movingMarkers) {
    if (!seenMovingKeys.has(key)) {
      _movingMarkers.delete(key);
      _markerTweens.delete(key);
      _movingMarkersContainer.removeChild(obj);
      obj.destroy({ children: true });
    }
  }

  const countEl = document.getElementById("mapMarkerCount");
  if (countEl) countEl.textContent = `${count} marker${count !== 1 ? "s" : ""}`;

  // Refresh the search results panel so new/changed vending listings appear
  if (_itemSearchQuery) _renderSearchResults();
}

// ── Vending Popup ────────────────────────────────────────────────────────────
function showVendingPopup(m, screenX, screenY) {
  closeVendingPopup();

  const overlay = document.getElementById("vendingPopupOverlay");
  if (!overlay) return;

  const name = m.name || "Vending Machine";
  const orders = m.sellOrders || [];

  let itemsHtml = "";
  for (const order of orders) {
    const sellName = getItemName(order.itemId);
    const sellShort = getItemShortname(order.itemId);
    const costName = getItemName(order.currencyId);
    const costShort = getItemShortname(order.currencyId);
    const soldOut = (order.amountInStock || 0) <= 0;
    const bpBadge = order.itemIsBlueprint
      ? '<span class="item-bp">BP</span> '
      : "";

    itemsHtml += `
      <div class="vending-order${soldOut ? " vending-order--soldout" : ""}">
        <div class="vending-order-sell">
          ${itemIconHTML(sellShort, 28)}
          <div>
            <div class="vending-order-name">${bpBadge}${escHtml(sellName)}</div>
            <div class="vending-order-qty">x${order.quantity || 0}</div>
          </div>
        </div>
        <div class="vending-order-arrow">&larr;</div>
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

  const popup = document.createElement("div");
  popup.id = "vendingPopup";
  popup.className = "vending-popup";
  popup.style.pointerEvents = "auto";
  const columnTitles = orders.length > 0
    ? `<div class="vending-order vending-order--titles">
         <div>Selling</div>
         <div></div>
         <div>Cost</div>
         <div></div>
       </div>`
    : "";
  popup.innerHTML = `
    <div class="vending-popup-header">
      <span class="vending-popup-name">${escHtml(name)}</span>
      <button class="vending-popup-close" onclick="closeVendingPopup()">&#x2715;</button>
    </div>
    <div class="vending-popup-orders">${columnTitles}${itemsHtml || '<div style="color:var(--text-muted);padding:8px">No items listed</div>'}</div>`;

  // Position near click
  const viewportRect = document
    .getElementById("mapViewport")
    .getBoundingClientRect();
  let left = screenX;
  let top = screenY - 10;

  popup.style.position = "absolute";
  popup.style.left = left + "px";
  popup.style.top = top + "px";
  popup.style.transform = "translateY(-100%)";

  overlay.appendChild(popup);

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    const vr = viewportRect;
    if (pr.right > vr.right) popup.style.left = left - pr.width + "px";
    if (pr.top < vr.top) {
      popup.style.top = screenY + 10 + "px";
      popup.style.transform = "none";
    }
  });
}

function closeVendingPopup() {
  const el = document.getElementById("vendingPopup");
  if (el) el.remove();
}

// ── Drawing Mode ─────────────────────────────────────────────────────────────
function updateDrawCursor() {
  if (!_pixiApp) return;
  const active = _drawMode || _eraseMode;
  _pixiApp.view.style.cursor = active ? "none" : "grab";
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
  _brushCursor.lineStyle(2.5, 0x000000, 1);
  _brushCursor.drawCircle(0, 0, Math.max(screenR, 2));
  _brushCursor.position.set(cx, cy);
  _brushCursor.visible = true;
}

function toggleDrawMode() {
  _drawMode = !_drawMode;
  if (_drawMode) _eraseMode = false;
  document
    .getElementById("mapDrawToggle")
    ?.classList.toggle("active", _drawMode);
  document
    .getElementById("mapEraseToggle")
    ?.classList.toggle("active", _eraseMode);
  updateDrawCursor();
}

async function toggleMapFullscreen() {
  const wrapper = document.getElementById("mapWrapper");
  if (!wrapper) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await wrapper.requestFullscreen();
  }
}

// When the browser enters/exits fullscreen, the wrapper's size changes; Pixi
// only listens to window resize, so we have to nudge it.
document.addEventListener("fullscreenchange", () => {
  if (_pixiApp) _pixiApp.resize();
});

function toggleEraseMode() {
  _eraseMode = !_eraseMode;
  if (_eraseMode) _drawMode = false;
  document
    .getElementById("mapEraseToggle")
    ?.classList.toggle("active", _eraseMode);
  document
    .getElementById("mapDrawToggle")
    ?.classList.toggle("active", _drawMode);
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
  // Absolute size in map (world) pixels — independent of zoom. Strokes look
  // bigger when zoomed in, smaller when zoomed out. The brush cursor still
  // scales correctly because it multiplies this by the container scale.
  return _drawWidth;
}

// ── GPU paint primitives ─────────────────────────────────────────────────────
// Build a soft brush sprite (or a container of them for line interpolation)
// and render it onto _drawRenderTexture. Pixel data never crosses CPU↔GPU
// during drawing — only stamp positions/sizes/tints.

function getBrushTexture() {
  if (_brushTexture) return _brushTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  // Solid core that fades to transparent at the rim. The 0.6 stop keeps the
  // center fully opaque, then the alpha falls off over the outer 40% for a
  // soft edge that still renders as a clearly-defined stroke.
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.6, "rgba(255,255,255,1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  _brushTexture = PIXI.Texture.from(canvas);
  return _brushTexture;
}

function _makeStamp(x, y, r) {
  const sprite = new PIXI.Sprite(getBrushTexture());
  sprite.anchor.set(0.5);
  sprite.x = x;
  sprite.y = y;
  sprite.width = r * 2;
  sprite.height = r * 2;
  if (_eraseMode) {
    sprite.tint = 0xffffff;
    sprite.blendMode = PIXI.BLEND_MODES.ERASE;
  } else {
    sprite.tint = hexToNum(_drawColor);
  }
  return sprite;
}

function paintAt(x, y) {
  if (!_drawRenderTexture || !_pixiApp) return;
  const sprite = _makeStamp(x, y, brushWorldSize());
  _pixiApp.renderer.render(sprite, {
    renderTexture: _drawRenderTexture,
    clear: false,
  });
  sprite.destroy();
  _drawDirty = true;
}

function paintLine(x0, y0, x1, y1) {
  if (!_drawRenderTexture || !_pixiApp) return;
  const r = brushWorldSize();
  // Stamp spacing: half the brush radius gives heavy overlap so consecutive
  // stamps form a continuous soft line without visible bumps.
  const step = Math.max(1, r / 2);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(dist / step));
  const container = new PIXI.Container();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    container.addChild(_makeStamp(x0 + dx * t, y0 + dy * t, r));
  }
  _pixiApp.renderer.render(container, {
    renderTexture: _drawRenderTexture,
    clear: false,
  });
  container.destroy({ children: true });
  _drawDirty = true;
}

function startDrawStroke(e) {
  _penDown = true;
  const p = screenToWorld(e.clientX, e.clientY);
  _lastDrawPt = p;
  paintAt(p.x, p.y);
}

function continueDrawStroke(e) {
  if (!_penDown) return;
  const p = screenToWorld(e.clientX, e.clientY);
  if (_lastDrawPt) paintLine(_lastDrawPt.x, _lastDrawPt.y, p.x, p.y);
  _lastDrawPt = p;
}

function endDrawStroke(e) {
  if (!_penDown) return;
  _penDown = false;
  _lastDrawPt = null;
  scheduleCanvasSave();
}

function eraseAtPoint(e) {
  startDrawStroke(e);
}

// ── Persistence (server-side, per server+map) ────────────────────────────────
function scheduleCanvasSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveDrawing, 2000);
}

async function saveDrawing() {
  if (!_drawRenderTexture || !_pixiApp || !_drawDirty) return;
  _drawDirty = false;
  const saveId = Math.random().toString(36).slice(2);
  _pendingSaveIds.add(saveId);
  try {
    // Snapshot the GPU texture back to a CPU canvas — the only readback in the
    // pipeline, and it only happens on the debounced save (~once per stroke).
    const canvas = _pixiApp.renderer.extract.canvas(_drawRenderTexture);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (!blob) throw new Error("toBlob returned null");
    const res = await fetch("/api/map/drawing", {
      method: "POST",
      headers: { "Content-Type": "image/png", "X-Save-Id": saveId },
      body: blob,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.error("Failed to save drawing:", e);
    _pendingSaveIds.delete(saveId);
  }
}

async function loadDrawing() {
  if (!_drawRenderTexture || !_pixiApp) return;
  try {
    const res = await fetch("/api/map/drawing", { cache: "no-cache" });
    if (res.status === 204) {
      // No drawing yet on server — clear local texture
      _pixiApp.renderer.render(new PIXI.Container(), {
        renderTexture: _drawRenderTexture,
        clear: true,
      });
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    URL.revokeObjectURL(url);
    const tex = PIXI.Texture.from(img);
    const sprite = new PIXI.Sprite(tex);
    _pixiApp.renderer.render(sprite, {
      renderTexture: _drawRenderTexture,
      clear: true,
    });
    sprite.destroy();
    tex.destroy(true);
  } catch (e) {
    console.error("Failed to load drawing:", e);
  }
}

// Called by api.js when another client (or our own POST) updates the drawing.
async function onDrawingUpdated(saveId) {
  if (saveId && _pendingSaveIds.has(saveId)) {
    _pendingSaveIds.delete(saveId);
    return; // it's our own save — skip the round-trip
  }
  await loadDrawing();
}

function clearDrawings() {
  if (_drawRenderTexture && _pixiApp) {
    _pixiApp.renderer.render(new PIXI.Container(), {
      renderTexture: _drawRenderTexture,
      clear: true,
    });
    _drawDirty = true;
    scheduleCanvasSave();
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
async function loadMap() {
  const container = document.getElementById("mapContainer");
  if (state.status !== "connected") {
    destroyMap();
    container.innerHTML =
      '<div class="empty-state"><div class="icon">🗺️</div><h3>Not connected</h3><p>Connect to a server to view the map.</p></div>';
    return;
  }

  try {
    if (!_pixiApp) {
      container.innerHTML =
        '<div class="empty-state"><div class="icon">🗺️</div><h3>Loading map...</h3><p>Fetching map data from server.</p></div>';
      // Init PixiJS app first (sets up DOM structure)
      await initPixiApp();
      // Then load image + data in parallel
      const [, markersRes, metaRes, teamRes] = await Promise.all([
        loadMapImage(),
        api("GET", "/api/map/markers"),
        api("GET", "/api/map/meta"),
        api("GET", "/api/map/team").catch(() => null),
      ]);
      _mapMeta = metaRes;
      _mapMarkers = markersRes.markers || [];
      _teamNotes = teamRes?.mapNotes || [];
      // Drawing fetch must run after /api/map (which seeds the server-side
      // map cache that the drawing key depends on)
      await loadDrawing();
      console.log(`Map loaded: ${_mapMarkers.length} markers, ${_teamNotes.length} team notes`);
      startMarkerAutoRefresh();
    } else {
      // Already loaded — force a resize in case the viewport size changed while
      // the tab was hidden (Pixi only resizes on window events, not element show)
      _pixiApp.resize();
      const [markersRes, metaRes, teamRes] = await Promise.all([
        api("GET", "/api/map/markers"),
        api("GET", "/api/map/meta"),
        api("GET", "/api/map/team").catch(() => null),
      ]);
      _mapMeta = metaRes;
      _mapMarkers = markersRes.markers || [];
      _teamNotes = teamRes?.mapNotes || [];
      console.log(`Map refreshed: ${_mapMarkers.length} markers, ${_teamNotes.length} team notes`);
    }
    await renderMarkers();
  } catch (e) {
    if (!_mapLoaded) {
      destroyMap();
      container.innerHTML = `<div class="empty-state"><div class="icon">🗺️</div><h3>Failed to load map</h3><p>${escHtml(e.message)}</p></div>`;
    }
    console.error("Map load error:", e, e?.stack);
  }
}

async function refreshMapMarkers() {
  const btn = document.querySelector(
    '.map-toolbar button[onclick="refreshMapMarkers()"]',
  );
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⟳";
  }
  try {
    const [markersRes, teamRes] = await Promise.all([
      api("GET", "/api/map/markers"),
      api("GET", "/api/map/team").catch(() => null),
    ]);
    _mapMarkers = markersRes.markers || [];
    _teamNotes = teamRes?.mapNotes || [];
    if (_pixiApp) _pixiApp.resize();
    await renderMarkers();
    console.log(`Markers refreshed: ${_mapMarkers.length}, ${_teamNotes.length} team notes`);
  } catch (e) {
    console.error("Failed to refresh markers:", e);
    alert(`Failed to refresh markers: ${e.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "↻";
    }
  }
}

// Quiet auto-refresh — no button feedback or alerts, used by the timer.
async function _refreshMarkersQuiet() {
  try {
    const [markersRes, teamRes] = await Promise.all([
      api("GET", "/api/map/markers"),
      api("GET", "/api/map/team").catch(() => null),
    ]);
    _mapMarkers = markersRes.markers || [];
    _teamNotes = teamRes?.mapNotes || [];
    await renderMarkers();
  } catch (e) {
    console.warn("Auto-refresh markers failed:", e.message);
  }
}

// Auto-refresh markers every 15s, but only while the map tab is visible AND
// the browser tab isn't hidden AND we're connected. This keeps player
// positions fresh without burning rate-limit tokens for nobody to see.
let _markerRefreshTimer = null;
const MARKER_REFRESH_INTERVAL_MS = 3000;
function startMarkerAutoRefresh() {
  stopMarkerAutoRefresh();
  _markerRefreshTimer = setInterval(() => {
    if (document.hidden) return;
    if (!document.body.classList.contains("section-map")) return;
    if (!_pixiApp || state.status !== "connected") return;
    _refreshMarkersQuiet();
  }, MARKER_REFRESH_INTERVAL_MS);
}
function stopMarkerAutoRefresh() {
  if (_markerRefreshTimer) clearInterval(_markerRefreshTimer);
  _markerRefreshTimer = null;
}

function destroyMap() {
  closeVendingPopup();
  clearTimeout(_saveTimer);
  stopMarkerAutoRefresh();
  // Flush any pending dirty paint before tearing down
  if (_drawDirty) saveDrawing();
  if (_drawRenderTexture) {
    _drawRenderTexture.destroy(true);
    _drawRenderTexture = null;
  }
  if (_pixiApp) {
    _pixiApp.destroy(true, {
      children: true,
      texture: true,
      baseTexture: true,
    });
    _pixiApp = null;
  }
  _mapContainer = null;
  _mapSprite = null;
  _markersContainer = null;
  _staticMarkersContainer = null;
  _movingMarkersContainer = null;
  _movingMarkers.clear();
  _markerTweens.clear();
  _drawSprite = null;
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
