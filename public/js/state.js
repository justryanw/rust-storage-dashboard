// ── Global state ──────────────────────────────────────────────────────────────
let state = { status: 'disconnected', inventory: {}, monitors: {}, config: {} };
let ws = null;
let currentView = 'slots';
let wsReconnectTimer = null;
let autoReconnectTimer = null;
const RECONNECT_INTERVAL = 5000;

const sessionStart = new Date().toISOString();
let lastHandledPairTimestamp = null;
let monitorQueue = [];
let promptedIds = new Set();
let monitorsInitialized = false;
let hasBeenConnected = false;
let currentTab = 'items';
let allItems = {};
