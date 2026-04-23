const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Patch the rustplus.proto BEFORE the library loads it. Several fields are
// declared `required` but Rust+ omits them in real responses (offline team
// members lack isOnline/x/y/spawnTime/etc., some entities lack
// itemIsBlueprint). Without this patch the strict protobuf decoder throws.
// nix/package.nix mirrors these patches at build time.
(function patchRustPlusProto() {
    const protoPath = path.join(__dirname, 'node_modules/@liamcottle/rustplus.js/rustplus.proto');
    if (!fs.existsSync(protoPath)) return;
    try {
        const original = fs.readFileSync(protoPath, 'utf8');
        // 1) Relax required→optional. Rust+ omits many declared-required
        //    fields, which would otherwise crash the strict decoder.
        let patched = original.replace(/\brequired\b/g, 'optional');
        // 2) The bundled proto's Note message is missing the icon/colour/
        //    label fields that newer Rust+ sends (verified empirically via
        //    /api/debug/team-raw — icon=5, colourIndex=6, label=7).
        if (!/colourIndex/.test(patched)) {
            patched = patched.replace(
                /(message Note \{[\s\S]*?optional float y = 4;)/,
                '$1\n\t\toptional int32 icon = 5;\n\t\toptional int32 colourIndex = 6;\n\t\toptional string label = 7;'
            );
        }
        if (patched !== original) {
            fs.writeFileSync(protoPath, patched);
            console.log('Patched rustplus.proto: required→optional + Note icon/colourIndex/label');
        }
    } catch (e) {
        console.warn('Failed to patch rustplus.proto:', e.message);
    }
})();

const RustPlus = require('@liamcottle/rustplus.js');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (continuing):', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (continuing):', reason?.message ?? reason);
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/pixi.js', express.static(path.join(__dirname, 'node_modules/pixi.js/dist/pixi.min.js')));

const DATA_DIR = process.env.RUST_PLUS_DASHBOARD_DATA_DIR
    || process.env.RUST_STORAGE_DASHBOARD_DATA_DIR  // legacy
    || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DRAWINGS_DIR = path.join(DATA_DIR, 'drawings');
const ITEMS_PATH = path.join(__dirname, 'items.json');

try { fs.mkdirSync(DRAWINGS_DIR, { recursive: true }); } catch (e) { console.error('Failed to create drawings dir:', e.message); }

let config = {};
let rustplus = null;
let combinedInventory = {};
let entityData = {};
let switchData = {};
let connectionStatus = 'disconnected';
let unpowerTimers = {};

// Token bucket matching Rust+ PlayerID limits (tighter than IP limits):
// 25 max, 3/sec replenishment. Enforces a minimum interval between releases
// so burst tokens are still released one-at-a-time rather than all at once.
class TokenBucket {
    constructor(max, ratePerSec) {
        this.max = max;
        this.tokens = 0; // start at 0 — don't assume burst is available
        this.rate = ratePerSec;
        this.last = Date.now();
        this.queue = [];
        this._scheduled = false;
        this.minInterval = Math.ceil(1000 / ratePerSec); // ms between releases
    }
    _refill() {
        const now = Date.now();
        this.tokens = Math.min(this.max, this.tokens + (now - this.last) / 1000 * this.rate);
        this.last = now;
    }
    acquire(cost = 1) {
        return new Promise(resolve => {
            this.queue.push({ cost, resolve });
            this._drain();
        });
    }
    _drain() {
        if (this._scheduled) return;
        this._refill();
        if (this.queue.length === 0) return;
        const next = this.queue[0];
        if (this.tokens >= next.cost) {
            this.tokens -= next.cost;
            this.queue.shift().resolve();
            if (this.queue.length > 0) {
                // Always enforce minimum interval between releases even during burst
                this._scheduled = true;
                setTimeout(() => { this._scheduled = false; this._drain(); }, this.minInterval);
            }
        } else {
            const wait = Math.ceil((next.cost - this.tokens) / this.rate * 1000);
            this._scheduled = true;
            setTimeout(() => { this._scheduled = false; this._drain(); }, wait);
        }
    }
    reset() {
        this.tokens = 0;
        this.last = Date.now();
        this.queue = [];
        this._scheduled = false;
    }
}
const rateLimiter = new TokenBucket(25, 2);
let connectionError = null;
let pairing = false;
let pushClient = null;
let lastPaired = null;

// Load persisted config
if (fs.existsSync(CONFIG_PATH)) {
    try {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        console.error('Failed to load config.json:', e.message);
    }
}

// Load item name mapping
let itemNames = {};
try {
    itemNames = JSON.parse(fs.readFileSync(ITEMS_PATH, 'utf8'));
} catch (e) {
    console.warn('Could not load items.json, item names will show as IDs');
}

function getItemName(itemId) {
    const id = String(itemId);
    const entry = itemNames[id];
    return (entry && entry.name) || entry || `Item #${itemId}`;
}

function getItemShortname(itemId) {
    const entry = itemNames[String(itemId)];
    return (entry && entry.shortname) || null;
}

function broadcast(payload) {
    const msg = JSON.stringify(payload);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msg); } catch (e) { console.error('WS broadcast error:', e.message); }
        }
    });
}

function broadcastState() {
    broadcast(buildState());
}

function buildState() {
    return {
        type: 'state',
        status: connectionStatus,
        error: connectionError,
        inventory: combinedInventory,
        monitors: entityData,
        switches: switchData,
        config: safeConfig(),
        lastPaired,
        lastUpdate: new Date().toISOString(),
    };
}

async function startPairing() {
    if (pushClient) {
        pushClient.removeAllListeners();
        try { await pushClient.destroy(); } catch (_) {}
        pushClient = null;
    }

    const { gcmAndroidId, gcmSecurityToken } = config;
    if (!gcmAndroidId || !gcmSecurityToken) {
        throw new Error('GCM credentials not configured');
    }

    // Credentials must be strings for Long.fromString() precision
    const androidId = String(gcmAndroidId);
    const securityToken = String(gcmSecurityToken);

    console.log(`Starting FCM listener (androidId: ${androidId.slice(0, 6)}...)`);

    pushClient = new PushReceiverClient(androidId, securityToken, []);

    pushClient.on('ON_DATA_RECEIVED', async (data) => {
        try {
            // Data is in appData array as key-value pairs
            const appData = data?.appData || [];
            const bodyEntry = appData.find(e => e.key === 'body');
            if (!bodyEntry) return;

            const body = JSON.parse(bodyEntry.value);

            const entityId = body.entityId;
            const entityType = Number(body.entityType);
            const pairedIp = body.ip;
            const pairedPort = body.port ? Number(body.port) : null;
            const pairedToken = body.playerToken;

            console.log(`Pairing: entityId=${entityId} type=${entityType} server=${pairedIp}:${pairedPort}`);

            // Warn about likely causes of `not_found`:
            //   - IP/port mismatch: dashboard is connected to a different server
            //   - playerToken mismatch (server matches): the entity is registered to a
            //     different player session/token. The saved token may still authenticate
            //     the websocket but won't have visibility of the entity.
            const ipMismatch = pairedIp && config.serverIp && pairedIp !== config.serverIp;
            const portMismatch = pairedPort && config.appPort && pairedPort !== Number(config.appPort);
            const tokenMismatch = pairedToken && config.playerToken && String(pairedToken) !== String(config.playerToken);
            const serverMismatch = ipMismatch || portMismatch;
            if (serverMismatch) {
                console.warn(
                    `⚠ Pairing server mismatch — entity is on ${pairedIp}:${pairedPort} ` +
                    `but dashboard is configured for ${config.serverIp}:${config.appPort}. ` +
                    `Update server settings (and player token) to fetch this entity.`
                );
            } else if (tokenMismatch) {
                console.warn(
                    `⚠ Pairing token mismatch — server matches but saved playerToken is stale. ` +
                    `Auto-updating saved token and reconnecting…`
                );
                config.playerToken = String(pairedToken);
                try {
                    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
                } catch (e) {
                    console.error('Failed to write config.json:', e.message);
                }
                if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
                    connectToServer(config).catch(console.error);
                }
            }

            // entityType 3 = StorageMonitor, entityType 1 = Switch
            // Record the pending pairing — the client will call confirm once the user names it.
            if (entityId && (entityType === 3 || entityType === 1)) {
                const id = String(entityId);
                lastPaired = {
                    entityId: id,
                    entityType,
                    timestamp: new Date().toISOString(),
                    pairedIp: pairedIp || null,
                    pairedPort: pairedPort || null,
                    serverMismatch: !!serverMismatch,
                    // tokenMismatch is auto-resolved above, so don't surface to UI
                };
                broadcastState();
            }
        } catch (e) {
            console.error('Error processing pairing notification:', e.message);
        }
    });

    pushClient.on('ON_SOCKET_CONNECT', () => console.log('FCM socket connected'));
    pushClient.on('ON_SOCKET_ERROR', (err) => console.error('FCM socket error:', err));
    pushClient.on('ON_SOCKET_CLOSE', () => console.log('FCM socket closed'));

    await pushClient.connect();
    pairing = true;
    console.log('FCM listener active — waiting for pairing notifications');
    broadcastState();
}

async function stopPairing() {
    if (pushClient) {
        pushClient.removeAllListeners();
        try { await pushClient.disconnect(); } catch (_) {}
        pushClient = null;
    }
    pairing = false;
    broadcastState();
}

function safeConfig() {
    const { playerToken, ...rest } = config;
    return { ...rest, playerToken: playerToken ? '••••••••' : '' };
}

function mergeInventory() {
    const merged = {};

    for (const [entityId, monitor] of Object.entries(entityData)) {
        if (!monitor.items) continue;
        for (const item of monitor.items) {
            const id = String(item.itemId);
            if (!merged[id]) {
                merged[id] = {
                    itemId: item.itemId,
                    name: getItemName(item.itemId),
                    shortname: getItemShortname(item.itemId),
                    quantity: 0,
                    isBlueprint: item.itemIsBlueprint,
                    sources: [],
                };
            }
            merged[id].quantity += item.quantity;
            if (!merged[id].sources.includes(entityId)) {
                merged[id].sources.push(entityId);
            }
        }
    }

    combinedInventory = merged;
}

async function pingServer() {
    await rateLimiter.acquire(1); // get_time costs 1
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        rustplus.getTime((message) => {
            clearTimeout(timeout);
            if (message.response && message.response.time) resolve();
            else reject(new Error('No time response'));
        });
    });
}

async function fetchEntityInfo(entityId) {
    await rateLimiter.acquire(1); // get_entity_info costs 1
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('Timeout')); }
        }, 5000);
        try {
            rustplus.getEntityInfo(parseInt(entityId), (message) => {
                clearTimeout(timeout);
                if (settled) return; // late response after timeout
                settled = true;
                if (message.response && message.response.entityInfo) {
                    resolve(message.response.entityInfo);
                } else if (message.response && message.response.error) {
                    reject(new Error(message.response.error.error || 'Entity error'));
                } else {
                    reject(new Error('Unexpected response'));
                }
            });
        } catch (e) {
            clearTimeout(timeout);
            if (!settled) { settled = true; reject(e); }
        }
    });
}

function markConnectionLost(reason) {
    console.warn(`Connection appears lost, disconnecting (${reason || 'unknown'})`);
    if (rustplus) { try { rustplus.disconnect(); } catch (_) {} rustplus = null; }
    connectionStatus = 'disconnected';
    connectionError = 'Connection lost';
    broadcastState();
}

async function setEntityValue(entityId, value) {
    await rateLimiter.acquire(1);
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) { settled = true; reject(new Error('Timeout')); }
        }, 5000);
        try {
            rustplus.setEntityValue(parseInt(entityId), value, (message) => {
                clearTimeout(timeout);
                if (settled) return;
                settled = true;
                if (message.response && !message.response.error) {
                    resolve();
                } else if (message.response && message.response.error) {
                    reject(new Error(message.response.error.error || 'Entity error'));
                } else {
                    reject(new Error('Unexpected response'));
                }
            });
        } catch (e) {
            clearTimeout(timeout);
            if (!settled) { settled = true; reject(e); }
        }
    });
}

async function refreshAllSwitches() {
    const switchIds = config.switchIds || [];
    for (const entityId of switchIds) {
        const id = String(entityId);
        try {
            const info = await fetchEntityInfo(entityId);
            const payload = info.payload || {};
            switchData[id] = {
                entityId: id,
                label: config.switchLabels?.[id] || `Switch ${entityId}`,
                type: info.type,
                value: !!payload.value,
                lastUpdated: new Date().toISOString(),
                error: null,
            };
        } catch (e) {
            switchData[id] = {
                entityId: id,
                label: config.switchLabels?.[id] || `Switch ${entityId}`,
                value: switchData[id]?.value || false,
                error: e.message,
                lastUpdated: switchData[id]?.lastUpdated || new Date().toISOString(),
            };
        }
    }
    broadcastState();
}

async function refreshAllEntities() {
    const entityIds = config.entityIds || [];
    const switchIds = config.switchIds || [];

    // Nothing to refresh — trust rustplus's own connection events to detect
    // dead sockets. Pinging here was the source of a reconnect loop on
    // configs with no monitors/switches: the ping would fail (e.g. token
    // bucket race during rapid reconnects) and we'd flap the connection.
    if (entityIds.length === 0 && switchIds.length === 0) {
        return;
    }

    if (entityIds.length > 0) {
        await fetchAndApplyEntities(entityIds);
        mergeInventory();
    }
    if (switchIds.length > 0) {
        await refreshAllSwitches();
    }
}

function applyEntityResult(entityId, info) {
    const id = String(entityId);
    const payload = info.payload || {};
    const unpowered = !payload.capacity;
    entityData[id] = {
        entityId: id,
        label: config.entityLabels?.[id] || `Monitor ${entityId}`,
        type: info.type,
        capacity: payload.capacity || entityData[id]?.capacity || 0,
        hasProtection: payload.hasProtection || false,
        protectionExpiry: payload.protectionExpiry || 0,
        items: unpowered ? (entityData[id]?.items || []) : (payload.items || []),
        unpowered,
        pending: false,
        lastUpdated: new Date().toISOString(),
        error: null,
    };
}

async function fetchAndApplyEntities(entityIds) {
    let timeouts = 0;
    const rateLimited = [];

    for (const entityId of entityIds) {
        const id = String(entityId);
        try {
            const info = await fetchEntityInfo(entityId);
            applyEntityResult(entityId, info);
            mergeInventory();
            broadcastState();
        } catch (e) {
            const msg = e.message;
            if (msg === 'Timeout') {
                timeouts++;
                console.warn(`Entity ${entityId} timed out — pausing 3s`);
                entityData[id] = { entityId: id, label: config.entityLabels?.[id] || `Monitor ${entityId}`, items: entityData[id]?.items || [], error: 'timeout', lastUpdated: entityData[id]?.lastUpdated || new Date().toISOString() };
                broadcastState();
                await new Promise(r => setTimeout(r, 3000));
            } else if (msg.includes('rate_limit')) {
                console.warn(`Entity ${entityId} rate limited — will retry`);
                rateLimited.push(entityId);
                if (!entityData[id]) {
                    entityData[id] = { entityId: id, label: config.entityLabels?.[id] || `Monitor ${entityId}`, items: [], error: 'rate_limit', lastUpdated: new Date().toISOString() };
                }
            } else {
                console.error(`Entity ${entityId} error:`, msg);
                entityData[id] = { entityId: id, label: config.entityLabels?.[id] || `Monitor ${entityId}`, items: entityData[id]?.items || [], error: msg, lastUpdated: new Date().toISOString() };
            }
        }
    }

    // Only treat as a possible dead connection if EVERY entity timed out (no response
    // at all). Server-side errors like not_found are successful round-trips and mean
    // the connection is alive — the entities just don't exist on this server.
    if (timeouts === entityIds.length && rateLimited.length === 0) {
        try { await pingServer(); } catch (_) { markConnectionLost('all entity requests timed out and ping failed'); }
        return;
    }

    mergeInventory();
    broadcastState();

    // Retry rate-limited entities
    if (rateLimited.length > 0) {
        await fetchAndApplyEntities(rateLimited);
    }
}

async function connectToServer(cfg) {
    // Disconnect existing connection
    if (rustplus) {
        try { rustplus.disconnect(); } catch (_) {}
        rustplus = null;
    }

    entityData = {};
    switchData = {};
    combinedInventory = {};
    connectionError = null;
    connectionStatus = 'connecting';
    cachedMapData = null;
    cachedServerInfo = null;
    cachedMapHash = null;
    rateLimiter.reset(); // fresh bucket on each connection attempt

    // Seed stubs for all configured entities so the UI shows them immediately
    for (const entityId of (cfg.entityIds || [])) {
        const id = String(entityId);
        entityData[id] = {
            entityId: id,
            label: cfg.entityLabels?.[id] || `Monitor ${entityId}`,
            items: [],
            capacity: 0,
            unpowered: false,
            pending: true,
            error: null,
            lastUpdated: null,
        };
    }

    // Seed stubs for switches
    for (const entityId of (cfg.switchIds || [])) {
        const id = String(entityId);
        switchData[id] = {
            entityId: id,
            label: cfg.switchLabels?.[id] || `Switch ${entityId}`,
            value: false,
            pending: true,
            error: null,
            lastUpdated: null,
        };
    }

    broadcastState();

    rustplus = new RustPlus(cfg.serverIp, parseInt(cfg.appPort), cfg.steamId, parseInt(cfg.playerToken));

    rustplus.on('connected', async () => {
        console.log('Connected to Rust+ server');
        connectionStatus = 'connected';
        connectionError = null;
        broadcastState();

        await refreshAllEntities();
    });

    rustplus.on('message', async (message) => {
        if (!message.broadcast?.entityChanged) return;

        const changed = message.broadcast.entityChanged;
        const entityId = String(changed.entityId);
        const payload = changed.payload;

        // Handle switch state changes
        if (switchData[entityId] !== undefined) {
            switchData[entityId].value = !!payload.value;
            switchData[entityId].lastUpdated = new Date().toISOString();
            switchData[entityId].error = null;
            broadcastState();
            return;
        }

        // value:true signals a change but carries no item data. It fires for both
        // power loss and item changes. Debounce: 500ms after the last value:true
        // with no value:false, fetch to confirm actual state.
        if (payload.value === true && entityData[entityId] !== undefined) {
            clearTimeout(unpowerTimers[entityId]);
            unpowerTimers[entityId] = setTimeout(() => {
                if (!entityData[entityId]) return;
                entityData[entityId].unpowered = true;
                entityData[entityId].lastUpdated = new Date().toISOString();
                mergeInventory();
                broadcastState();
            }, 500);
        }

        // value:false carries the actual item list and confirms the monitor is powered
        if (payload.value === false && entityData[entityId] !== undefined) {
            clearTimeout(unpowerTimers[entityId]);
            delete unpowerTimers[entityId];
            entityData[entityId].unpowered = false;
            entityData[entityId].items = payload.items || [];
            entityData[entityId].capacity = payload.capacity || entityData[entityId].capacity;
            entityData[entityId].lastUpdated = new Date().toISOString();
            mergeInventory();
            broadcastState();
        }
    });

    rustplus.on('disconnected', () => {
        console.log('Disconnected from Rust+ server');
        connectionStatus = 'disconnected';
        Object.values(unpowerTimers).forEach(clearTimeout);
        unpowerTimers = {};
        broadcastState();
    });

    rustplus.on('error', (err) => {
        console.error('RustPlus error:', err);
        connectionStatus = 'error';
        connectionError = err?.message || String(err);
        broadcastState();
    });

    rustplus.connect();
}

// ── REST API ────────────────────────────────────────────────────────────────

app.get('/api/state', (_, res) => res.json(buildState()));

app.get('/api/items', (_, res) => {
    const items = Object.entries(itemNames).map(([id, entry]) => ({
        itemId: Number(id),
        name: (entry && entry.name) || entry || `Item #${id}`,
        shortname: (entry && entry.shortname) || null,
    }));
    res.json(items);
});

app.get('/api/config', (_, res) => res.json(safeConfig()));

app.post('/api/config', (req, res) => {
    const { playerToken, ...fields } = req.body;
    config = { ...config, ...fields };
    // Update playerToken if explicitly sent and not the masked placeholder
    if (playerToken !== undefined && !String(playerToken).includes('•')) {
        config.playerToken = playerToken;
    }
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('Failed to write config.json:', e.message);
        return res.status(500).json({ error: 'Failed to save config' });
    }

    const hasConnection = config.serverIp && config.appPort && config.steamId && config.playerToken;

    if (!hasConnection) {
        // Config is now incomplete — disconnect if needed, always broadcast so client reflects new config
        if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
            if (rustplus) { try { rustplus.disconnect(); } catch (_) {} rustplus = null; }
            connectionStatus = 'disconnected';
            connectionError = null;
            entityData = {};
            switchData = {};
            combinedInventory = {};
        }
        broadcastState();
    } else if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
        // Config changed while connected — reconnect with new details
        connectToServer(config).catch(console.error);
    } else {
        // Config is complete and we're disconnected — trigger auto-connect
        connectToServer(config).catch(console.error);
    }

    res.json({ success: true });
});

app.post('/api/connect', async (req, res) => {
    if (!config.serverIp || !config.appPort || !config.steamId || !config.playerToken) {
        return res.status(400).json({ error: 'Missing required config fields' });
    }
    // Don't await — connection is async
    connectToServer(config).catch(console.error);
    res.json({ success: true, message: 'Connecting...' });
});

app.post('/api/disconnect', (_, res) => {
    if (rustplus) {
        try { rustplus.disconnect(); } catch (_) {}
        rustplus = null;
    }
    connectionStatus = 'disconnected';
    connectionError = null;
    entityData = {};
    switchData = {};
    combinedInventory = {};
    broadcastState();
    res.json({ success: true });
});

app.delete('/api/monitor/:entityId', (req, res) => {
    const id = req.params.entityId;
    delete entityData[id];
    config.entityIds = (config.entityIds || []).filter(e => String(e) !== id);
    if (config.entityLabels) delete config.entityLabels[id];
    if (config.entityGroups) delete config.entityGroups[id];
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('Failed to write config.json:', e.message); }
    mergeInventory();
    broadcastState();
    res.json({ success: true });
});

app.post('/api/rename-group', (req, res) => {
    const { oldName, newName } = req.body;
    if (!oldName || !newName || !newName.trim()) return res.status(400).json({ error: 'oldName and newName required' });
    const trimmed = newName.trim();
    if (!config.entityGroups) return res.json({ success: true });
    for (const id of Object.keys(config.entityGroups)) {
        if (config.entityGroups[id] === oldName) config.entityGroups[id] = trimmed;
    }
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('Failed to write config.json:', e.message); }
    mergeInventory();
    broadcastState();
    res.json({ success: true });
});

app.post('/api/monitor/confirm', async (req, res) => {
    const { entityId, name, group } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const id = String(entityId);

    if (!config.entityIds) config.entityIds = [];
    if (!config.entityIds.map(String).includes(id)) config.entityIds.push(id);
    if (name) {
        if (!config.entityLabels) config.entityLabels = {};
        config.entityLabels[id] = name;
    }
    if (group && group.trim()) {
        if (!config.entityGroups) config.entityGroups = {};
        config.entityGroups[id] = group.trim();
    } else if (config.entityGroups) {
        delete config.entityGroups[id];
    }
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('Failed to write config.json:', e.message); }

    if (connectionStatus === 'connected') {
        try {
            const info = await fetchEntityInfo(id);
            const p = info.payload || {};
            const unpowered = !p.capacity;
            entityData[id] = {
                entityId: id,
                label: name || `Monitor ${id}`,
                type: info.type,
                capacity: p.capacity || entityData[id]?.capacity || 0,
                hasProtection: p.hasProtection || false,
                items: unpowered ? (entityData[id]?.items || []) : (p.items || []),
                unpowered,
                lastUpdated: new Date().toISOString(),
                error: null,
            };
            mergeInventory();
        } catch (e) {
            entityData[id] = {
                entityId: id,
                label: name || `Monitor ${id}`,
                items: [],
                error: e.message,
                lastUpdated: new Date().toISOString(),
            };
        }
    }

    broadcastState();
    res.json({ success: true });
});

app.post('/api/refresh/:entityId', async (req, res) => {
    if (connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'Not connected' });
    }
    const id = req.params.entityId;
    try {
        const info = await fetchEntityInfo(id);
        applyEntityResult(id, info);
        mergeInventory();
        broadcastState();
        res.json({ success: true });
    } catch (e) {
        console.error(`/api/refresh/${id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Switch API ───────────────────────────────────────────────────────────────

// Static routes must come before parameterized ones
app.post('/api/switch/confirm', async (req, res) => {
    const { entityId, name } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const id = String(entityId);

    if (!config.switchIds) config.switchIds = [];
    if (!config.switchIds.map(String).includes(id)) config.switchIds.push(id);
    if (name) {
        if (!config.switchLabels) config.switchLabels = {};
        config.switchLabels[id] = name;
    }
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('Failed to write config.json:', e.message); }

    if (connectionStatus === 'connected') {
        try {
            const info = await fetchEntityInfo(id);
            const payload = info.payload || {};
            switchData[id] = {
                entityId: id,
                label: name || `Switch ${id}`,
                type: info.type,
                value: !!payload.value,
                lastUpdated: new Date().toISOString(),
                error: null,
            };
        } catch (e) {
            switchData[id] = {
                entityId: id,
                label: name || `Switch ${id}`,
                value: false,
                error: e.message,
                lastUpdated: new Date().toISOString(),
            };
        }
    }

    broadcastState();
    res.json({ success: true });
});

app.post('/api/switch/refresh', async (req, res) => {
    if (connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        await refreshAllSwitches();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/switch/:entityId', (req, res) => {
    const id = req.params.entityId;
    delete switchData[id];
    config.switchIds = (config.switchIds || []).filter(e => String(e) !== id);
    if (config.switchLabels) delete config.switchLabels[id];
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('Failed to write config.json:', e.message); }
    broadcastState();
    res.json({ success: true });
});

app.post('/api/switch/:entityId/toggle', async (req, res) => {
    if (connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'Not connected' });
    }
    const id = req.params.entityId;
    const sw = switchData[id];
    if (!sw) return res.status(404).json({ error: 'Switch not found' });

    const newValue = !sw.value;
    try {
        await setEntityValue(id, newValue);
        switchData[id].value = newValue;
        switchData[id].lastUpdated = new Date().toISOString();
        switchData[id].error = null;
        broadcastState();
        res.json({ success: true, value: newValue });
    } catch (e) {
        console.error(`Switch ${id} toggle error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/switch/:entityId/rename', (req, res) => {
    const id = req.params.entityId;
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    if (!config.switchLabels) config.switchLabels = {};
    config.switchLabels[id] = name.trim();
    if (switchData[id]) switchData[id].label = name.trim();
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch (e) { console.error('Failed to write config.json:', e.message); }
    broadcastState();
    res.json({ success: true });
});

// ── Map API ──────────────────────────────────────────────────────────────────

let cachedMapData = null;
let cachedServerInfo = null;
let cachedMapHash = null;

// Per-server, per-map drawing storage. The hash invalidates on wipe (different
// map JPEG → different hash → different file), so old drawings don't bleed
// across to a new wipe.
function mapHash() {
    if (cachedMapHash) return cachedMapHash;
    if (!cachedMapData) return null;
    cachedMapHash = crypto.createHash('sha256').update(cachedMapData.jpgImage).digest('hex').slice(0, 16);
    return cachedMapHash;
}

function drawingPath() {
    if (!config.serverIp || !config.appPort) return null;
    const hash = mapHash();
    if (!hash) return null;
    const safeIp = String(config.serverIp).replace(/[^a-zA-Z0-9]/g, '_');
    return path.join(DRAWINGS_DIR, `${safeIp}_${config.appPort}_${hash}.png`);
}

app.get('/api/map', async (_, res) => {
    if (connectionStatus !== 'connected' || !rustplus) {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        if (!cachedMapData) {
            await rateLimiter.acquire(1);
            cachedMapData = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);
                rustplus.getMap((msg) => {
                    clearTimeout(timeout);
                    if (msg.response && msg.response.map) resolve(msg.response.map);
                    else reject(new Error('No map data'));
                });
            });
        }
        res.set('Content-Type', 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=300');
        res.send(Buffer.from(cachedMapData.jpgImage));
    } catch (e) {
        console.error('/api/map error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/map/meta', async (_, res) => {
    if (connectionStatus !== 'connected' || !rustplus) {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        if (!cachedMapData) {
            await rateLimiter.acquire(1);
            cachedMapData = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 15000);
                rustplus.getMap((msg) => {
                    clearTimeout(timeout);
                    if (msg.response && msg.response.map) resolve(msg.response.map);
                    else reject(new Error('No map data'));
                });
            });
        }
        const monuments = (cachedMapData.monuments || []).map(m => ({
            token: m.token,
            x: m.x,
            y: m.y,
        }));
        // Fetch server info for mapSize if not cached
        if (!cachedServerInfo) {
            await rateLimiter.acquire(1);
            cachedServerInfo = await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
                rustplus.getInfo((msg) => {
                    clearTimeout(timeout);
                    if (msg.response && msg.response.info) resolve(msg.response.info);
                    else reject(new Error('No info data'));
                });
            });
        }
        const mapSize = cachedServerInfo.mapSize || 0;
        res.json({
            width: cachedMapData.width,
            height: cachedMapData.height,
            oceanMargin: cachedMapData.oceanMargin,
            mapSize,
            background: cachedMapData.background || null,
            monuments,
        });
    } catch (e) {
        console.error('/api/map/meta error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/map/markers', async (_, res) => {
    if (connectionStatus !== 'connected' || !rustplus) {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        await rateLimiter.acquire(1);
        const markers = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 30000);
            rustplus.getMapMarkers((msg) => {
                clearTimeout(timeout);
                if (msg.response && msg.response.mapMarkers) resolve(msg.response.mapMarkers);
                else reject(new Error('No marker data'));
            });
        });
        res.json(markers);
    } catch (e) {
        console.error('/api/map/markers error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Drawing layer — per-server, per-map PNG persisted to disk and broadcast to
// all connected clients on save. Eventually-consistent: last save wins.
app.get('/api/map/drawing', async (_, res) => {
    const p = drawingPath();
    if (!p) return res.status(204).end();
    try {
        const buf = await fs.promises.readFile(p);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'no-cache');
        res.send(buf);
    } catch (e) {
        if (e.code === 'ENOENT') return res.status(204).end();
        console.error('/api/map/drawing GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/map/drawing', express.raw({ type: 'image/png', limit: '20mb' }), async (req, res) => {
    const p = drawingPath();
    if (!p) return res.status(400).json({ error: 'No active server/map — load the map first' });
    if (!req.body || req.body.length === 0) return res.status(400).json({ error: 'Empty body' });
    try {
        await fs.promises.writeFile(p, req.body);
        // Echo the saveId from the client header so the saver can ignore its own broadcast
        const saveId = req.get('X-Save-Id') || null;
        broadcast({ type: 'drawingUpdated', saveId });
        res.json({ success: true });
    } catch (e) {
        console.error('/api/map/drawing POST error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Steam profile lookup ─────────────────────────────────────────────────────
// Server-side proxy + cache for Steam Community profile XML. Avoids client
// CORS issues, dedupes lookups across all connected clients, and keeps a 24h
// cache so we don't hammer Steam for repeat marker refreshes.
const _steamProfileCache = new Map(); // steamId -> { name, avatar, avatarFull, expiresAt }
const STEAM_PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

function _parseSteamXml(xml) {
    const grab = (tag) => {
        const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'));
        return m ? m[1].trim() : null;
    };
    return {
        name: grab('steamID'),
        avatar: grab('avatarMedium') || grab('avatarIcon'),
        avatarFull: grab('avatarFull'),
    };
}

app.get('/api/steam/profile/:steamId', async (req, res) => {
    const id = req.params.steamId;
    if (!/^\d{17}$/.test(id)) return res.status(400).json({ error: 'Invalid steamId' });
    const now = Date.now();
    const cached = _steamProfileCache.get(id);
    if (cached && cached.expiresAt > now) return res.json(cached);
    try {
        const r = await fetch(`https://steamcommunity.com/profiles/${id}?xml=1`, {
            headers: { 'User-Agent': 'rust-plus-dashboard' },
        });
        if (!r.ok) throw new Error(`Steam HTTP ${r.status}`);
        const xml = await r.text();
        const parsed = _parseSteamXml(xml);
        const profile = { ...parsed, steamId: id, expiresAt: now + STEAM_PROFILE_TTL_MS };
        _steamProfileCache.set(id, profile);
        res.json(profile);
    } catch (e) {
        console.error(`/api/steam/profile/${id} error:`, e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/map/team', async (_, res) => {
    if (connectionStatus !== 'connected' || !rustplus) {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        await rateLimiter.acquire(1);
        const teamInfo = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
            rustplus.getTeamInfo((msg) => {
                clearTimeout(timeout);
                if (msg.response && msg.response.teamInfo) resolve(msg.response.teamInfo);
                else reject(new Error('No team info'));
            });
        });
        res.json(teamInfo);
    } catch (e) {
        console.error('/api/map/team error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/map/info', async (_, res) => {
    if (connectionStatus !== 'connected' || !rustplus) {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        await rateLimiter.acquire(1);
        const info = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
            rustplus.getInfo((msg) => {
                clearTimeout(timeout);
                if (msg.response && msg.response.info) resolve(msg.response.info);
                else reject(new Error('No info data'));
            });
        });
        res.json(info);
    } catch (e) {
        console.error('/api/map/info error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/refresh', async (_, res) => {
    if (connectionStatus !== 'connected') {
        return res.status(400).json({ error: 'Not connected' });
    }
    try {
        await refreshAllEntities();
        broadcastState();
        res.json({ success: true });
    } catch (e) {
        console.error('/api/refresh error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// WebSocket: send current state on connect
wss.on('connection', (ws) => {
    try { ws.send(JSON.stringify(buildState())); } catch (e) { console.error('WS send error:', e.message); }
});

const PORT = process.env.PORT || 7867;
server.listen(PORT, '::', () => {
    console.log(`Rust+ Dashboard → http://localhost:${PORT}`);
    // Auto-start FCM pairing listener if credentials are available
    if (config.gcmAndroidId && config.gcmSecurityToken) {
        startPairing().catch(e => console.warn('Pairing listener failed to start:', e.message));
    }
    // Auto-connect on startup if config is complete
    if (config.serverIp && config.appPort && config.steamId && config.playerToken) {
        console.log('Auto-connecting with saved config...');
        connectToServer(config).catch(console.error);
    }
});

