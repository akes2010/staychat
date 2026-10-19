// server/ws.js
// Lightweight real-time layer with enhanced security
// Each connected client joins a tenant "room" and receives JSON events for that tenant only.

const { WebSocketServer, WebSocket } = require('ws');
const { verifyAccessToken } = require('./utils/tokens');
const url = require('url');

let wss = null;
let heartbeatInterval = null;
const tenantClients = new Map(); // tenantId -> Set<ws>
// Room for platform operators: every tenant-less (superadmin) connection joins
// it, so targeted platform events — e.g. a new Desk PC Edition registration
// awaiting payment — actually reach the operator console. (broadcast(null, …)
// is a no-op by design: a falsy tenantId never addresses a room.)
const SUPERADMIN_ROOM = '__none__';
const clientMetadata = new WeakMap(); // Store client metadata

// Security settings
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds (2 missed heartbeats)
// Cap concurrent WS connections per tenant. A tenant can only connect users
// that hold one of ITS JWTs, so this is a runaway/protection knob, not a
// multi-tenancy limit: the default comfortably covers a 500–1000 seat hotel
// (the SPA opens ONE socket per tab). Operators can tune per deployment via
// WS_MAX_CLIENTS_PER_TENANT. Before this was raised + made configurable, a
// busy hotel silently lost every connection past the old hard-coded 100 —
// the load test showed 577 of 1000 sockets kicked mid-session.
const MAX_CLIENTS_PER_TENANT = (() => {
  const n = parseInt(process.env.WS_MAX_CLIENTS_PER_TENANT, 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

function attach(server) {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: MAX_MESSAGE_SIZE, // Prevent large payload attacks
  });

  wss.on('connection', (ws, req) => {
    const { query } = url.parse(req.url, true);
    let tenantId = null;
    let role = null;
    let userId = null;

    // Verify token from query parameter
    try {
      const token = query.token || '';
      if (!token) {
        ws.close(4001, 'No token provided');
        return;
      }

      const payload = verifyAccessToken(token);
      tenantId = payload.tenantId;
      role = payload.role;
      userId = payload.sub;
    } catch (e) {
      console.warn(`WebSocket auth failed: ${e.message} from ${req.socket.remoteAddress}`);
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Superadmin can specify tenant
    if (role === 'superadmin' && query.tenantId) tenantId = query.tenantId;
    
    // Handle superadmin with no tenant — they still join the platform room so
    // broadcastSuperadmins() (and cleanup below) treat them like any client.
    if (!tenantId) {
      ws.tenantId = SUPERADMIN_ROOM;
      if (!tenantClients.has(SUPERADMIN_ROOM)) tenantClients.set(SUPERADMIN_ROOM, new Set());
      tenantClients.get(SUPERADMIN_ROOM).add(ws);
    } else {
      // Enforce connection limit per tenant
      const currentClients = tenantClients.get(tenantId);
      if (currentClients && currentClients.size >= MAX_CLIENTS_PER_TENANT) {
        ws.close(4002, 'Too many connections');
        return;
      }
      
      ws.tenantId = tenantId;
      if (!tenantClients.has(tenantId)) tenantClients.set(tenantId, new Set());
      tenantClients.get(tenantId).add(ws);
    }

    // Store client metadata
    clientMetadata.set(ws, {
      tenantId: ws.tenantId,
      userId,
      role,
      connectedAt: Date.now(),
      ip: req.socket.remoteAddress,
    });

    // Send connection confirmation
    ws.send(JSON.stringify({ 
      type: 'connected', 
      tenantId: ws.tenantId,
      timestamp: Date.now(),
    }));

    // Handle client messages (only pong responses expected)
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        // Only accept pong messages from client
        if (data.type !== 'pong') {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message type' }));
        }
      } catch (e) {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      const set = tenantClients.get(ws.tenantId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) tenantClients.delete(ws.tenantId);
      }
      clientMetadata.delete(ws);
    });

    // Handle errors gracefully
    ws.on('error', (err) => {
      console.error(`WebSocket error for tenant ${ws.tenantId}:`, err.message);
    });

    // Heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { 
      ws.isAlive = true; 
    });

    // Log connection
    console.log(`WebSocket connected: tenant=${ws.tenantId}, user=${userId}, ip=${req.socket.remoteAddress}`);
  });

  // Ping clients periodically to detect dead connections
  heartbeatInterval = setInterval(() => {
    if (!wss) return;
    
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        console.warn(`Terminating inactive WebSocket for tenant ${ws.tenantId}`);
        return ws.terminate();
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (e) {
        ws.terminate();
      }
    });
  }, HEARTBEAT_INTERVAL);
  heartbeatInterval.unref();

  // Clean up interval on server close
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log(`✓ WebSocket server attached at /ws (max payload: 64KB, max clients/tenant: ${MAX_CLIENTS_PER_TENANT})`);
}

/**
 * Close every live client (graceful shutdown). Sends a normal close frame so
 * the SPA reconnects against the new process instead of seeing dead sockets.
 */
function closeAll(code = 1001, reason = 'server shutting down') {
  if (!wss) return;
  clearInterval(heartbeatInterval);
  tenantClients.forEach((set) => set.clear());
  tenantClients.clear();
  wss.clients.forEach((client) => {
    try { client.close(code, reason); } catch (e) { try { client.terminate(); } catch (e2) { /* already gone */ } }
  });
}

/**
 * Broadcast a message to all clients in a tenant room
 * @param {string} tenantId - Tenant ID
 * @param {string} type - Message type
 * @param {Object} payload - Message payload
 */
function broadcast(tenantId, type, payload) {
  if (!wss || !tenantId) return;
  const set = tenantClients.get(tenantId);
  if (!set || set.size === 0) return;
  
  const msg = JSON.stringify({ 
    type, 
    payload, 
    ts: Date.now(),
  });
  
  let sent = 0;
  set.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(msg);
        sent++;
      } catch (e) {
        console.error(`Failed to send to client: ${e.message}`);
      }
    }
  });
  
  return sent;
}

/**
 * Broadcast to all tenants (superadmin broadcasts)
 */
function broadcastAll(type, payload) {
  if (!wss) return;
  
  tenantClients.forEach((clients, tenantId) => {
    broadcast(tenantId, type, { ...payload, _broadcastAll: true });
  });
}

/**
 * Send to every platform-operator session (tenant-less superadmins only).
 * Used for platform-level signals such as new Desk PC Edition registrations.
 */
function broadcastSuperadmins(type, payload) {
  return broadcast(SUPERADMIN_ROOM, type, payload);
}

/**
 * Get connection statistics
 */
function getStats() {
  const stats = {
    totalConnections: 0,
    tenantConnections: {},
  };
  
  tenantClients.forEach((clients, tenantId) => {
    stats.tenantConnections[tenantId] = clients.size;
    stats.totalConnections += clients.size;
  });
  
  return stats;
}

module.exports = { attach, broadcast, broadcastAll, broadcastSuperadmins, getStats, closeAll };
