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

// MUST load before any ./routes/* module: forwards rejected promises from
// async route handlers to the error handler instead of crashing the process
// (Express 4 drops them → `unhandledRejection` → Node kills the server).
require('./utils/async-safe');

require('./db/migrate');

// SaaS boot: seed the platform plan catalog (public pricing + superadmin
// console read from it) and suspend trials that expired while we were down —
// before the first request can hit a route guard. The subscription scheduler
// (renewal reminders + expiry sweeps) then runs once now and hourly after —
// interval configurable via SCHEDULER_INTERVAL_MINUTES (default 60).
require('./services/entitlements').ensurePlansSeeded();
require('./services/entitlements').sweepExpiredTrials();
require('./services/subscription-scheduler').start(
  (Number(process.env.SCHEDULER_INTERVAL_MINUTES) || 60) * 60 * 1000
);

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
// Global API rate limit.
// RATE_LIMIT_GLOBAL_MAX raises the per-IP budget for deployments where many
// staff share one egress IP (an office NAT'd behind a single router can trip
// 200/min at shift start). Default keeps the tighter, safer posture.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 200, // Requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  // Keyed by the library's built-in IPv6-safe IP resolver. (A user-ID key is not
  // possible here: this limiter is mounted before auth, so req.user is unset.)
});

// Broad gate for the /api/auth/* family (login, refresh, register, forgot…).
// The per-route limiters in routes/auth.js carry the real brute-force
// protection with skipSuccessful/skipFailedRequests tuned per endpoint; this
// one just stops a machine from sitting on the whole family. It used to be
// 20/15min with no exemptions — every tab's session-restore refresh counted
// against it, so a NAT'd office of ~10 staff tripped it at shift start and
// got the SAME "console full of Not authenticated" lockout. Now: only
// successful requests count (a flood of refused refreshes from dead sessions
// can no longer eat the budget needed for real logins), and the ceiling
// covers realistic multi-staff bursts. Brute force is still dead-ended by
// loginLimiter (30 failed/15min) below.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  skipFailedRequests: true,
  message: { error: 'Too many authentication attempts. Please try again later.' },
});

app.use('/api', globalLimiter);

// ── Cookie Parser ───────────────────────────────────────────────────────────
if (!process.env.COOKIE_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('FATAL: COOKIE_SECRET must be set in production environment');
}

// ── Maintenance Mode (env-var toggle — no code or data changes needed) ──────
// deploy/update.sh sets MAINTENANCE=1 in .env during updates and lifts it on
// success. Gate order matters: health endpoints stay up (monitoring + the
// update script itself poll them); WhatsApp/payment webhooks stay up so Meta
// doesn't disable the integration during a maintenance window; everything
// else that would touch tenant data answers 503 with a clean retry JSON.
const MAINTENANCE_EXEMPT = (p) =>
  p === '/api/health' || p.startsWith('/api/health/') ||
  p.startsWith('/api/webhooks/') ||
  p === '/maintenance.html' || p.startsWith('/maintenance-assets');
app.use((req, res, next) => {
  if (String(process.env.MAINTENANCE || '') !== '1' || MAINTENANCE_EXEMPT(req.path)) return next();
  // Public guest pages still read (read-only) so guests can view the booking
  // wiki; anything that writes is gated AFTER auth below.
  if (req.method === 'GET' && !req.path.startsWith('/api/')) return next();
  res.status(503).set('Retry-After', '300').json({
    error: 'Scheduled maintenance — the system is being updated. Please try again in a few minutes.',
    maintenance: true,
    retryAfterSeconds: 300,
  });
});
app.use(cookieParser(process.env.COOKIE_SECRET || 'dev-only-insecure-secret'));

// ── Logging ─────────────────────────────────────────────────────────────────
// Production: structured logging with request ID
// Development: colored morgan with dev format
// ACCESS_LOG=off silences the per-request access log entirely (default: on).
// At 500–1000 concurrent users this stream is ~100–400 lines/s (~10–30MB/min)
// — set it off when another pipeline (file shipper, sidecar) already captures
// stdout, or when running load tests, to keep log volume sane.
const accessLog = String(process.env.ACCESS_LOG || 'on').toLowerCase();
if (!['off', '0', 'false', 'no'].includes(accessLog)) {
  if (isProduction) {
    app.use(morgan(':method :url :status :res[content-length] - :response-time ms [:date[iso]] :req[x-request-id]'));
  } else {
    app.use(morgan('dev'));
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/room-setup', require('./routes/room-setup').router);
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/wifi', require('./routes/wifi'));
app.use('/api/booking-engine', require('./routes/booking-engine'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/help', require('./routes/help'));
app.use('/api/pool', require('./routes/pool'));
app.use('/api/halls', require('./routes/halls'));
app.use('/api/gym', require('./routes/gym'));
// Additive module: quarterly registrations + Gym & Pool combined membership
// plans (owns its own tables; see server/routes/fitness.js header).
app.use('/api/fitness', require('./routes/fitness'));
app.use('/api/tables', require('./routes/tables'));
app.use('/api/guests', require('./routes/guests'));
app.use('/api/blocklist', require('./routes/blocklist'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/pos', require('./routes/pos'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/eod', require('./routes/eod'));
app.use('/api/misc-services', require('./routes/misc-services'));
app.use('/api/ai-config', require('./routes/ai-config'));
app.use('/api/printers', require('./routes/printers'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/billing', require('./routes/billing'));
app.use('/api/selfhost', require('./routes/selfhost')); // one-time $3,000 Desk PC Edition (self-hosted)
app.use('/api/reports', require('./routes/reports'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/users', require('./routes/users'));
app.use('/api/menu/categories', require('./routes/menu-categories'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/maintenance', require('./routes/maintenance'));
app.use('/api/inbox', require('./routes/inbox'));
app.use('/api/messaging', require('./routes/messaging'));
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

// ── Stale-UI detector: /api/version ─────────────────────────────────────────
// The app ships un-hashed JS filenames, so a staff browser that loaded the
// page once can keep running OLD page code for as long as that session lives
// (single-page navigation never refetches <script src> tags). This endpoint
// stamps WHO the server is (boot id) and WHAT it serves (UI build stamp, a
// cheap hash of the page-module code). The client caches the values it booted
// with and asks this endpoint every few minutes; a mismatch means VM
// operations swapped the code underneath the screen — tell the user plainly.
const crypto = require('crypto');
const fs = require('fs');
let uiBuildStamp = null;
function computeUiBuildStamp() {
  if (uiBuildStamp) return uiBuildStamp;
  try {
    const hash = crypto.createHash('sha256');
    fs.readdirSync(path.join(__dirname, '..', 'public', 'js', 'pages')).sort().forEach(f => {
      hash.update(f).update(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pages', f)));
    });
    hash.update(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js')));
    hash.update(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ui.js')));
    hash.update(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js')));
    hash.update(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html')));
    uiBuildStamp = hash.digest('hex').slice(0, 12);
  } catch (e) {
    uiBuildStamp = 'unknown';
  }
  return uiBuildStamp;
}
const SERVER_BOOT_ID = 'boot_' + nanoid(10);
app.get('/api/version', (req, res) => {
  res.json({
    version: process.env.APP_VERSION || '1.0.0',
    bootId: SERVER_BOOT_ID,
    uiBuildStamp: computeUiBuildStamp(),
    time: new Date().toISOString(),
  });
});

// Detailed health check for load balancers
app.get('/api/health/detailed', (req, res) => {
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
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
    // Cumulative CPU time (user+system, microseconds) since process start.
    // Monitoring clients diff two samples against wall time to get CPU %.
    cpu: cpuUsage,
    env: process.env.NODE_ENV,
  });
});

// ── Static Files ────────────────────────────────────────────────────────────
// Explicit page routes BEFORE static: `/` is the public marketing landing
// page, `/app` is the dashboard SPA. Every other deep link falls through to
// the SPA below, so existing bookmarks keep working.
// All HTML is served with `Cache-Control: no-cache` — it must always
// revalidate (ETag → 304) so a fixed page is visible to every visitor
// immediately after deploy. Without this, a poisoned page (e.g. one shipped
// with a JS syntax error) stays dead in visitors' browsers for as long as
// the cache entry is fresh, no matter what the fixed server sends afterwards.
function sendPage(name) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '..', 'public', name));
  };
}
app.get('/', sendPage('landing.html'));
app.get('/app', sendPage('index.html'));
app.get('/signup', sendPage('signup.html'));
app.get('/pay', sendPage('pay.html'));
app.get('/reset-password', sendPage('reset-password.html'));
app.get('/help', sendPage('help.html'));

app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: isProduction ? '1d' : 0, // Cache immutable-ish assets in production
  etag: true,
  // HTML AND application JS/CSS must always REVALIDATE, never be served
  // straight from the HTTP cache. HTML for the poisoned-page reasons below;
  // JS because the app ships un-hashed filenames (`/js/pages/payments.js`)
  // — a 1-day max-age meant every staff browser kept running the old modal
  // code for up to a day after a fix deployed ("can't type the amount
  // collected at checkout"). Revalidation is cheap (ETag → 304), so pages
  // stay fast while every deploy is picked up on the next load.
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.setHeader('Cache-Control', 'no-cache');
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

// NOTE: process-level safety nets (unhandledRejection / uncaughtException →
// log & keep serving) are installed by ./utils/async-safe, loaded at the top.

// ── Graceful shutdown ──────────────────────────────────────────────────────
// Deploys/restarts send SIGTERM (Docker, pm2, systemd). Drain WebSocket
// clients and in-flight HTTP requests first so live users reconnect cleanly
// instead of hitting dead sockets, then exit — also letting --cpu-prof and
// other atexit hooks flush their output. Hard-exit fallback after 3s.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining connections before exit`);
  try { ws.closeAll(); } catch (e) { /* ws may not be attached */ }
  server.close(() => process.exit(0));
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

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
