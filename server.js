const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const RustPlus = require('@liamcottle/rustplus.js');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');
const fs = require('fs');
const path = require('path');

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

const DATA_DIR = process.env.RUST_STORAGE_DASHBOARD_DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ITEMS_PATH = path.join(__dirname, 'items.json');

let config = {};
let rustplus = null;
let combinedInventory = {};
let entityData = {};
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

function broadcastState() {
    const state = buildState();
    const msg = JSON.stringify(state);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(msg); } catch (e) { console.error('WS broadcast error:', e.message); }
        }
    });
}

function buildState() {
    return {
        status: connectionStatus,
        error: connectionError,
        inventory: combinedInventory,
        monitors: entityData,
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
        console.log('FCM notification received:', JSON.stringify(data));
        try {
            // Data is in appData array as key-value pairs
            const appData = data?.appData || [];
            const bodyEntry = appData.find(e => e.key === 'body');
            if (!bodyEntry) return;

            const body = JSON.parse(bodyEntry.value);

            const entityId = body.entityId;
            const entityType = Number(body.entityType);

            console.log(`Pairing: entityId=${entityId} type=${entityType} ip=${body.ip}`);

            // entityType 3 = StorageMonitor — record the pending pairing but don't add yet.
            // The client will call /api/monitor/confirm once the user names it.
            if (entityId && entityType === 3) {
                const id = String(entityId);
                lastPaired = { entityId: id, timestamp: new Date().toISOString() };
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

function markConnectionLost() {
    console.warn('Connection appears lost, disconnecting');
    if (rustplus) { try { rustplus.disconnect(); } catch (_) {} rustplus = null; }
    connectionStatus = 'disconnected';
    connectionError = 'Connection lost';
    broadcastState();
}

async function refreshAllEntities() {
    const entityIds = config.entityIds || [];

    // If no monitors configured, probe with a lightweight ping instead
    if (entityIds.length === 0) {
        try { await pingServer(); } catch (_) { markConnectionLost(); }
        return;
    }

    await fetchAndApplyEntities(entityIds);
    mergeInventory();
}

function applyEntityResult(entityId, info) {
    const id = String(entityId);
    const payload = info.payload || {};
    const unpowered = !payload.capacity;
    entityData[id] = {
        entityId: id,
        label: config.entityLabels?.[id] || `Monitor ${entityId}`,
        type: info.type,
        capacity: payload.capacity || 0,
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
    let failures = 0;
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
            failures++;
            if (msg === 'Timeout') {
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

    // If every entity failed (not just rate limited), check if connection is alive
    if (failures === entityIds.length && rateLimited.length === 0) {
        try { await pingServer(); } catch (_) { markConnectionLost(); }
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
    combinedInventory = {};
    connectionError = null;
    connectionStatus = 'connecting';
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
                capacity: p.capacity || 0,
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
    console.log(`Rust Storage Dashboard → http://localhost:${PORT}`);
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
