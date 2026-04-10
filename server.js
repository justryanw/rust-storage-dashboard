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

const CONFIG_PATH = path.join(__dirname, 'config.json');
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
            client.send(msg);
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
            const serverIp = body.ip;
            const serverPort = body.port;
            const name = body.name;

            console.log(`Pairing: entityId=${entityId} type=${entityType} ip=${serverIp}`);

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

function fetchEntityInfo(entityId) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
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

async function refreshAllEntities() {
    const entityIds = config.entityIds || [];
    for (const entityId of entityIds) {
        try {
            const info = await fetchEntityInfo(entityId);
            const payload = info.payload || {};
            const unpowered = !payload.capacity;
            entityData[String(entityId)] = {
                entityId: String(entityId),
                label: config.entityLabels?.[String(entityId)] || `Monitor ${entityId}`,
                type: info.type,
                capacity: payload.capacity || 0,
                hasProtection: payload.hasProtection || false,
                protectionExpiry: payload.protectionExpiry || 0,
                items: unpowered ? [] : (payload.items || []),
                unpowered,
                lastUpdated: new Date().toISOString(),
                error: null,
            };
        } catch (e) {
            console.error(`Entity ${entityId} error:`, e.message);
            entityData[String(entityId)] = {
                entityId: String(entityId),
                label: config.entityLabels?.[String(entityId)] || `Monitor ${entityId}`,
                items: [],
                error: e.message,
                lastUpdated: new Date().toISOString(),
            };
        }
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
    // Only update playerToken if a real value (not masked) was sent
    if (playerToken && !playerToken.includes('•')) {
        config.playerToken = playerToken;
    }
    config = { ...config, ...fields };
    if (fields.playerToken !== undefined && !fields.playerToken.includes('•')) {
        config.playerToken = fields.playerToken;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    mergeInventory();
    broadcastState();
    res.json({ success: true });
});

app.post('/api/monitor/confirm', async (req, res) => {
    const { entityId, name } = req.body;
    if (!entityId) return res.status(400).json({ error: 'entityId required' });
    const id = String(entityId);

    if (!config.entityIds) config.entityIds = [];
    if (!config.entityIds.includes(Number(id))) config.entityIds.push(Number(id));
    if (name) {
        if (!config.entityLabels) config.entityLabels = {};
        config.entityLabels[id] = name;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

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
    await refreshAllEntities();
    broadcastState();
    res.json({ success: true });
});

// WebSocket: send current state on connect
wss.on('connection', (ws) => {
    ws.send(JSON.stringify(buildState()));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Storage Monitor Dashboard → http://localhost:${PORT}`);
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
