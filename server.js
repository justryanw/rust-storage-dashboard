const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const RustPlus = require('@liamcottle/rustplus.js');
const PushReceiverClient = require('@liamcottle/push-receiver/src/client');
const fs = require('fs');
const path = require('path');

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
let pollTimer = null;
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

function pingServer() {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        rustplus.getTime((message) => {
            clearTimeout(timeout);
            if (message.response && message.response.time) resolve();
            else reject(new Error('No time response'));
        });
    });
}

function fetchEntityInfo(entityId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
        rustplus.getEntityInfo(parseInt(entityId), (message) => {
            clearTimeout(timeout);
            if (message.response && message.response.entityInfo) {
                resolve(message.response.entityInfo);
            } else if (message.response && message.response.error) {
                reject(new Error(message.response.error.error || 'Entity error'));
            } else {
                reject(new Error('Unexpected response'));
            }
        });
    });
}

function markConnectionLost() {
    console.warn('Connection appears lost, disconnecting');
    clearInterval(pollTimer);
    pollTimer = null;
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

    // Fetch all entities in parallel so timeouts don't stack sequentially
    const results = await Promise.allSettled(entityIds.map(entityId => fetchEntityInfo(entityId)));

    let failures = 0;
    results.forEach((result, i) => {
        const entityId = entityIds[i];
        const id = String(entityId);
        if (result.status === 'fulfilled') {
            const info = result.value;
            const payload = info.payload || {};
            const unpowered = !payload.capacity;
            entityData[id] = {
                entityId: id,
                label: config.entityLabels?.[id] || `Monitor ${entityId}`,
                type: info.type,
                capacity: payload.capacity || 0,
                hasProtection: payload.hasProtection || false,
                protectionExpiry: payload.protectionExpiry || 0,
                items: unpowered ? [] : (payload.items || []),
                unpowered,
                lastUpdated: new Date().toISOString(),
                error: null,
            };
        } else {
            console.error(`Entity ${entityId} error:`, result.reason.message);
            failures++;
            entityData[id] = {
                entityId: id,
                label: config.entityLabels?.[id] || `Monitor ${entityId}`,
                items: [],
                error: result.reason.message,
                lastUpdated: new Date().toISOString(),
            };
        }
    });

    // If every entity timed out, the underlying connection is dead
    if (failures === entityIds.length) {
        markConnectionLost();
        return;
    }

    mergeInventory();
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
    broadcastState();

    rustplus = new RustPlus(cfg.serverIp, parseInt(cfg.appPort), cfg.steamId, parseInt(cfg.playerToken));

    rustplus.on('connected', async () => {
        console.log('Connected to Rust+ server');
        connectionStatus = 'connected';
        connectionError = null;
        broadcastState();

        await refreshAllEntities();
        broadcastState();

        clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            if (connectionStatus === 'connected') {
                await refreshAllEntities();
                broadcastState();
            }
        }, 5000);
    });

    rustplus.on('message', async (message) => {
        if (!message.broadcast?.entityChanged) return;

        const changed = message.broadcast.entityChanged;
        const entityId = String(changed.entityId);
        const payload = changed.payload;

        // value:true may be a power-loss or just the first of two item-change broadcasts.
        // Debounce: if no value:false follows within 500ms, treat as unpowered.
        if (payload.value === true && entityData[entityId] !== undefined) {
            clearTimeout(unpowerTimers[entityId]);
            unpowerTimers[entityId] = setTimeout(() => {
                if (entityData[entityId]) {
                    entityData[entityId].unpowered = true;
                    entityData[entityId].items = [];
                    entityData[entityId].lastUpdated = new Date().toISOString();
                    mergeInventory();
                    broadcastState();
                }
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
        clearInterval(pollTimer);
        pollTimer = null;
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
            clearInterval(pollTimer);
            pollTimer = null;
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
    clearInterval(pollTimer);
    pollTimer = null;
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
                items: unpowered ? [] : (p.items || []),
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
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
