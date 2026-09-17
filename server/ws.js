// server/ws.js
// Lightweight real-time layer with enhanced security
// Each connected client joins a tenant "room" and receives JSON events for that tenant only.

const { WebSocketServer, WebSocket } = require('ws');
const { verifyAccessToken } = require('./utils/tokens');
const url = require('url');

let wss = null;
const tenantClients = new Map(); // tenantId -> Set<ws>
const clientMetadata = new WeakMap(); // Store client metadata

// Security settings
const MAX_MESSAGE_SIZE = 64 * 1024; // 64KB max message size
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds (2 missed heartbeats)
const MAX_CLIENTS_PER_TENANT = 100; // Limit connections per tenant

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
    
    // Handle superadmin with no tenant
    if (!tenantId) {
      ws.tenantId = '__none__';
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
  const heartbeatInterval = setInterval(() => {
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

  // Clean up interval on server close
  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  console.log('✓ WebSocket server attached at /ws (max payload: 64KB)');
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

module.exports = { attach, broadcast, broadcastAll, getStats };
