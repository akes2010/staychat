// server/middleware/idempotency.js
// Request-level idempotency for the offline-first PWA.
//
// While offline, the client queues write requests (booking creation, guest
// registration, check-in, check-out, settle) in IndexedDB and replays them
// when the connection returns. A replay must NEVER execute twice — a double
// check-out or a double settlement is real damage. So every queued request
// carries an `Idempotency-Key` header, and this middleware guarantees the
// server executes each key exactly once:
//
//   • no key             → pass through untouched. Online clients and every
//                           request already in production behave EXACTLY as
//                           before (zero behavioral change without a key).
//   • key + same payload → replay the STORED 2xx response — the original
//                           execution ran once; the replay gets the same
//                           answer the client would have received live.
//   • key + other body   → 409 IDEMPOTENCY_MISMATCH (a key identifies ONE
//                           intent; reusing it for different data is a bug).
//   • key claimed, no    → 409 IN_FLIGHT — the original request is still
//     response yet          executing; the client retries moments later.
//   • non-2xx response   → the key is released so a corrected retry with the
//                           same key can run (errors are never cached).
//
// Keys are scoped per tenant (tenant_id + ':' + key), so two hotels can never
// collide, and expire after 48h (lazy cleanup on each use — an offline device
// that comes back days later falls back to a normal first execution, still
// guarded by the route's own validation and transaction re-checks).
'use strict';
const crypto = require('crypto');
const db = require('../db/connection');

const REPLAY_TTL = '-48 hours';
const IN_FLIGHT_MS = 60 * 1000; // a claim older than this with no response is considered crashed

// Deep key-sorted JSON so the payload hash does not depend on property order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => { acc[k] = canonical(value[k]); return acc; }, {});
  }
  return value;
}

function hashRequest(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : {};
  delete body._idempotencyKey;
  return crypto.createHash('sha256')
    .update(req.method + ' ' + (req.originalUrl || req.url).split('?')[0] + '\n' + JSON.stringify(canonical(body)))
    .digest('hex');
}

function idempotency(req, res, next) {
  if (req.method !== 'POST' && req.method !== 'PATCH' && req.method !== 'PUT') return next();
  const raw = req.get('Idempotency-Key') || (req.body && req.body._idempotencyKey);
  if (!raw) return next();
  // Only meaningful behind resolveTenant — mounted routes all are.
  if (!req.tenantId) return next();
  const key = String(raw).slice(0, 128);
  const scope = req.tenantId + ':' + key;

  // Lazy housekeeping: keys no client will ever replay again.
  try { db.prepare("DELETE FROM idempotency_keys WHERE created_at < datetime('now', ?)").run(REPLAY_TTL); } catch (e) { /* non-fatal */ }

  const hash = hashRequest(req);

  const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(scope);
  if (existing) {
    if (existing.request_hash !== hash) {
      return res.status(409).json({
        error: 'This idempotency key was already used for a different request',
        code: 'IDEMPOTENCY_MISMATCH',
      });
    }
    if (existing.status != null) {
      // Exact original answer, original status code, marked as a replay.
      res.set('Idempotent-Replay', 'true');
      res.status(existing.status);
      res.type('application/json');
      return res.send(existing.response_body || 'null');
    }
    // Claimed but not yet answered: in flight, or the original died mid-way.
    const claimedAt = Date.parse(String(existing.created_at || '').replace(' ', 'T') + 'Z');
    if (Number.isFinite(claimedAt) && Date.now() - claimedAt < IN_FLIGHT_MS) {
      return res.status(409).json({ error: 'This request is still being processed — retry in a moment', code: 'IN_FLIGHT' });
    }
    db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(scope); // stale claim → re-claim below
  }

  try {
    db.prepare(`INSERT INTO idempotency_keys (key, tenant_id, user_id, method, path, request_hash, created_at)
                VALUES (?,?,?,?,?,?,datetime('now'))`)
      .run(scope, req.tenantId, req.user ? req.user.id : null, req.method, (req.originalUrl || req.url).split('?')[0], hash);
  } catch (e) {
    // Unique violation: a concurrent request just claimed this exact key.
    return res.status(409).json({ error: 'This request is already being processed — retry in a moment', code: 'IN_FLIGHT' });
  }

  // Capture a successful response so replays return the original answer;
  // release the key on any error so a corrected retry can execute.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        db.prepare('UPDATE idempotency_keys SET status = ?, response_body = ? WHERE key = ?')
          .run(res.statusCode, JSON.stringify(body), scope);
      } else {
        db.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(scope);
      }
    } catch (e) { /* never break the response over bookkeeping */ }
    return originalJson(body);
  };

  next();
}

module.exports = { idempotency };
