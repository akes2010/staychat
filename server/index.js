// server/index.js
// StayChat OS — Production-ready server with comprehensive security
'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');

require('./db/migrate');
const ws = require('./ws');

// ── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Behind the reverse proxies this project documents (Nginx, Caddy, Render, Fly),
// req.ip is otherwise the proxy's IP for every client: the global and auth rate
// limiters would bucket ALL visitors into one shared limit (one busy hotel could
// lock everyone out), and audit-log IPs would record nothing useful. Trust the
// first proxy hop only — express-rate-limit v7 explicitly requires this to be set.
app.set('trust proxy', 1);

// ── Request ID Middleware ────────────────────────────────────────────────────
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || nanoid(16);
  res.setHeader('X-Request-ID', req.id);

  // Set X-Response-Time just before the headers are flushed. Doing this in a
  // 'finish' listener would throw ERR_HTTP_HEADERS_SENT (headers are already
  // sent by then) — an uncaught exception that crashed the process after the
  // first request. res.on('finish') timing is instead recorded via morgan.
  const startTime = Date.now();
  const origWriteHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.headersSent) res.setHeader('X-Response-Time', `${Date.now() - startTime}ms`);
    return origWriteHead.apply(this, args);
  };
  next();
});

// ── Security Headers (Helmet) ───────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
  // CSP disabled entirely for now — the inline-handler UI architecture is
  // incompatible with strict CSP. Re-enable with proper nonces after refactoring
  // event handlers to external listeners, or accept 'unsafe-inline'/'unsafe-eval'.
  contentSecurityPolicy: false,
  
  // Other security headers
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
}));

// ── CORS Configuration ───────────────────────────────────────────────────────
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim()).filter(Boolean)
  : [];

// SECURITY: never pair `origin: true` (reflect any origin) with credentials in
// production — that lets any website make credentialed cross-origin requests.
// If CORS_ORIGIN is unset we fall back to same-origin only (origin: false) in
// production, and permissive reflection only in development for convenience.
let corsOrigin;
if (allowedOrigins.length > 0) {
  corsOrigin = allowedOrigins;
} else if (isProduction) {
  console.warn('⚠️ CORS_ORIGIN is not set — restricting to same-origin requests only. Set CORS_ORIGIN to allow browser clients on other domains.');
  corsOrigin = false;
} else {
  corsOrigin = true; // dev convenience: reflect origin
}

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['X-Request-ID', 'X-Response-Time'],
  maxAge: 86400, // 24 hours
}));

// ── Body Parsers ─────────────────────────────────────────────────────────────
// Webhooks need raw access; everything else gets JSON parsing.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/webhooks/')) return next();
  express.json({ limit: '1mb' })(req, res, next); // Reduced from 2mb
});

// ── Rate Limiting ───────────────────────────────────────────────────────────
// Global API rate limit
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // Requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  // Keyed by the library's built-in IPv6-safe IP resolver. (A user-ID key is not
  // possible here: this limiter is mounted before auth, so req.user is unset.)
});

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

app.use('/api', globalLimiter);

// ── Cookie Parser ───────────────────────────────────────────────────────────
if (!process.env.COOKIE_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: COOKIE_SECRET must be set in production environment');
}
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-only-insecure-secret'));

// ── Logging ─────────────────────────────────────────────────────────────────
// Production: structured logging with request ID
// Development: colored morgan with dev format
if (isProduction) {
  app.use(morgan(':method :url :status :res[content-length] - :response-time ms [:date[iso]] :req[x-request-id]'));
} else {
  app.use(morgan('dev'));
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/room-setup', require('./routes/room-setup').router);
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/wifi', require('./routes/wifi'));
app.use('/api/booking-engine', require('./routes/booking-engine'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/pool', require('./routes/pool'));
app.use('/api/halls', require('./routes/halls'));
app.use('/api/guests', require('./routes/guests'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/eod', require('./routes/eod'));
app.use('/api/misc-services', require('./routes/misc-services'));
app.use('/api/ai-config', require('./routes/ai-config'));
app.use('/api/printers', require('./routes/printers'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/users', require('./routes/users'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/maintenance', require('./routes/maintenance'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/api-integrations', require('./routes/api-integrations'));
app.use('/api/superadmin', require('./routes/superadmin'));
app.use('/api/webhooks', require('./routes/webhooks'));

// ── Health Check ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0',
    uptime: process.uptime(),
    requestId: req.id,
  });
});

// Detailed health check for load balancers
app.get('/api/health/detailed', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0',
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
    },
    env: process.env.NODE_ENV,
  });
});

// ── Static Files ────────────────────────────────────────────────────────────
// Explicit page routes BEFORE static: `/` is the public marketing landing
// page, `/app` is the dashboard SPA. Every other deep link falls through to
// the SPA below, so existing bookmarks keep working.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: isProduction ? '1d' : 0, // Cache static assets in production
  etag: true,
}));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── 404 Handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
    requestId: req.id,
  });
});

// ── Global Error Handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Log error with context
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    requestId: req.id,
    error: err.message,
    stack: isProduction ? undefined : err.stack,
    path: req.path,
    method: req.method,
    ip: req.ip,
    userId: req.user?.id,
  }));

  // Don't leak error details in production
  if (res.headersSent) return next(err);

  // Handle specific error types
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON payload', requestId: req.id });
  }

  if (err.code === 'EBADCSRFTOKEN') {
    return res.status(403).json({ error: 'Invalid or missing CSRF token', requestId: req.id });
  }

  res.status(err.status || 500).json({
    error: isProduction ? 'Internal server error' : err.message,
    requestId: req.id,
  });
});

// ── Server Startup ──────────────────────────────────────────────────────────
ws.attach(server);

// PORT=0 is a legitimate request for an OS-assigned ephemeral port (used by the
// HTTP test harness), so the fallback must trigger on NaN only — a bare `|| 3000`
// would coerce 0 to 3000 and collide with any real server already listening.
const parsedPort = parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════════════════════════════════╗');
  console.log('  ║              StayChat OS — Production Ready                   ║');
  console.log('  ╠════════════════════════════════════════════════════════════════╣');
  console.log(`  ║   Server:    http://${HOST}:${PORT}`.padEnd(60) + '║');
  console.log(`  ║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(46)}║`);
  console.log(`  ║   Version:   ${(process.env.APP_VERSION || '1.0.0').padEnd(46)}║`);
  console.log(`  ║   RequestID: Enabled`.padEnd(60) + '║');
  console.log(`  ║   Security:  Helmet + CORS + Rate Limiting`.padEnd(60) + '║');
  console.log('  ╚════════════════════════════════════════════════════════════════╝');
  console.log('');
});

module.exports = { app, server };
