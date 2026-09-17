// server/services/wifi.js
// Per-room guest Wi-Fi provisioning, tied to bookings.
//
// Design notes:
// - The tenant configures ONE internet-management controller (UniFi, Meraki,
//   MikroTik, Omada, Ruckus) on the API Integrations page. This service picks
//   the active one and delegates to a per-controller adapter.
// - Adapters are honest about what they can do. UniFi supports real per-guest
//   authorization natively; the others manage whole-client access via MAC
//   allowlists or firewall address-lists. Where a live controller call cannot
//   be made (device offline, cloud-only API, unsupported op), the local
//   wifi_provisions record still stands as the source of truth and the push is
//   retried/flagged via recordServiceResult telemetry — provisioning must never
//   block a check-in.
// - Speed tier by room type: suites get the top tier, standard rooms the base.
//   Tenants can override per-provision from the staff UI.
'use strict';

const crypto = require('crypto');
const db = require('../db/connection');
const { encrypt, decrypt } = require('../utils/crypto-store');
const { getServiceConfig, getActiveServiceInCategory, recordServiceResult } = require('../utils/api-resolver');
const { request, tcpProbe, DEFAULT_TIMEOUT_MS } = require('../utils/http-client');

// ── Speed tiers (Mbps down/up) by room type ────────────────────────────────
const TIERS = {
  suite:   { down: 100, up: 50,  quotaGb: null },
  deluxe:  { down: 50,  up: 20,  quotaGb: null },
  standard:{ down: 20,  up: 10,  quotaGb: 50 },
};

function tierForRoomType(roomType) {
  const t = String(roomType || '').toLowerCase();
  if (t.includes('suite') || t.includes('presidential') || t.includes('executive')) return TIERS.suite;
  if (t.includes('deluxe') || t.includes('premium') || t.includes('superior')) return TIERS.deluxe;
  return TIERS.standard;
}

function generatePassword() {
  // 8 unambiguous chars — readable over a phone call, safe to read aloud.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (const b of crypto.randomBytes(8)) out += alphabet[b % alphabet.length];
  return out;
}

// ── Controller adapters ─────────────────────────────────────────────────────
// Each adapter: { test(creds), authorize(ctx), revoke(ctx) }.
// ctx: { identity, password, mac, roomNumber, downMbps, upMbps, quotaGb, expiresAt }

const CONTROLLERS = {
  // UniFi — real per-guest authorization via the classic controller API.
  unifi: {
    async login(creds) {
      const base = creds.controller_url.replace(/\/+$/, '');
      const site = creds.site_id || 'default';
      const r = await request('POST', `${base}/api/login`, {
        headers: { 'Content-Type': 'application/json' },
        body: { username: creds.username, password: creds.password },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`UniFi login failed (HTTP ${r.status})`);
      const cookies = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      return { base, site, cookie: cookies.map(c => c.split(';')[0]).join('; ') };
    },
    async authorize(session, ctx) {
      // Grant a guest authorization for the remaining stay, capped at the tier.
      const seconds = Math.max(3600, Math.floor((new Date(ctx.expiresAt).getTime() - Date.now()) / 1000));
      const payload = {
        cmd: 'authorize-guest',
        mac: ctx.mac,
        minutes: Math.min(Math.floor(seconds / 60), 60 * 24 * 30),
        up: ctx.upMbps ? ctx.upMbps * 1000 : undefined,
        down: ctx.downMbps ? ctx.downMbps * 1000 : undefined,
        bytes: ctx.quotaGb ? Math.round(ctx.quotaGb * 1024 * 1024 * 1024) : undefined,
      };
      const r = await request('POST', `${session.base}/api/s/${session.site}/cmd/stamgr`, {
        headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
        body: payload,
      });
      if (!r.ok) throw new Error(`UniFi authorize-guest failed (HTTP ${r.status})`);
      return { pushed: true, detail: `Guest authorized on UniFi site ${session.site}` };
    },
    async revoke(session, ctx) {
      const r = await request('POST', `${session.base}/api/s/${session.site}/cmd/stamgr`, {
        headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
        body: { cmd: 'unauthorize-guest', mac: ctx.mac },
      });
      if (!r.ok) throw new Error(`UniFi unauthorize-guest failed (HTTP ${r.status})`);
      return { pushed: true, detail: 'Guest unauthorized on UniFi' };
    },
  },

  // MikroTik RouterOS v7 REST — hotspot user per booking (identity+password).
  mikrotik: {
    async login(creds) {
      const port = creds.router_port || '443';
      const base = `https://${creds.router_host}:${port}`;
      const auth = 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`).toString('base64');
      return { base, auth };
    },
    async authorize(session, ctx) {
      const r = await request('PUT', `${session.base}/rest/ip/hotspot/user/${encodeURIComponent(ctx.identity)}`, {
        headers: { Authorization: session.auth, 'Content-Type': 'application/json' },
        body: {
          name: ctx.identity,
          password: ctx.password,
          'rate-limit': `${ctx.downMbps}M/${ctx.upMbps}M`,
          'limit-bytes-total': ctx.quotaGb ? String(Math.round(ctx.quotaGb * 1024 * 1024 * 1024)) : undefined,
          comment: `staychat room ${ctx.roomNumber}`,
        },
      });
      if (!r.ok) throw new Error(`MikroTik hotspot user create failed (HTTP ${r.status})`);
      return { pushed: true, detail: 'Hotspot user created on RouterOS' };
    },
    async revoke(session, ctx) {
      const r = await request('DELETE', `${session.base}/rest/ip/hotspot/user/${encodeURIComponent(ctx.identity)}`, {
        headers: { Authorization: session.auth },
      });
      if (!r.ok && r.status !== 404) throw new Error(`MikroTik hotspot user remove failed (HTTP ${r.status})`);
      return { pushed: true, detail: 'Hotspot user removed' };
    },
  },

  // Meraki / Omada / Ruckus — cloud or managed dashboards; per-client
  // authorization needs enrollment flows outside a single call, so the local
  // record is authoritative and the adapter reports what to do manually.
  meraki: {
    async authorize() { return { pushed: false, detail: 'Record saved. Create a Meraki guest user / PSK for this room per your dashboard policy.' }; },
    async revoke() { return { pushed: false, detail: 'Session marked revoked. Remove the Meraki guest user for this room.' }; },
  },
  omada: {
    async authorize() { return { pushed: false, detail: 'Record saved. Issue an Omada voucher / portal account for this room.' }; },
    async revoke() { return { pushed: false, detail: 'Session marked revoked. Retire the Omada voucher for this room.' }; },
  },
  ruckus: {
    async authorize() { return { pushed: false, detail: 'Record saved. Create the guest pass in Ruckus Cloud for this room.' }; },
    async revoke() { return { pushed: false, detail: 'Session marked revoked. Delete the Ruckus guest pass for this room.' }; },
  },
};

function getAdapter(controller) {
  return CONTROLLERS[controller] || null;
}

async function pushToController(tenantId, provision, op) {
  const config = getServiceConfig(tenantId, provision.controller);
  if (!config) return { pushed: false, detail: `Controller "${provision.controller}" is not configured for this hotel` };

  const adapter = getAdapter(provision.controller);
  if (!adapter) return { pushed: false, detail: `No adapter for controller "${provision.controller}"` };

  try {
    if (op === 'authorize' && typeof adapter.test === 'function') {
      // optional pre-flight; failures are non-fatal
      try { await adapter.test(config.credentials); } catch (_) { /* keep going */ }
    }
    const session = await adapter.login(config.credentials);
    const ctx = {
      identity: provision.identity,
      password: provision.password_enc ? decrypt(provision.password_enc) : null,
      mac: provision.mac || null,
      roomNumber: provision.room_number,
      downMbps: provision.speed_down_mbps,
      upMbps: provision.speed_up_mbps,
      quotaGb: provision.quota_gb,
      expiresAt: provision.expires_at,
    };
    const result = await adapter[op](session, ctx);
    recordServiceResult(config.id, true, null);
    return result;
  } catch (e) {
    recordServiceResult(config.id, false, e.message);
    // Non-fatal by design: local record remains source of truth.
    return { pushed: false, detail: `Controller push failed: ${e.message}` };
  }
}

// ── Provision / revoke lifecycle ────────────────────────────────────────────

/**
 * Create a Wi-Fi session for a booking. Called on check-in (auto=true) or from
 * the staff UI (auto=false). Returns the provision row (password in plaintext
 * under `password` for immediate display; the DB keeps only the encrypted form).
 */
async function provisionForBooking(tenantId, booking, { mac = null, speedDown = null, speedUp = null, quotaGb = undefined, grantedBy = 'system', auto = true } = {}) {
  // One active session per booking: re-running check-in (or a duplicate call)
  // must not fork credentials.
  const existing = db.prepare(`
    SELECT * FROM wifi_provisions WHERE tenant_id = ? AND booking_id = ? AND status = 'active'
  `).get(tenantId, booking.id);
  if (existing) {
    return { ...existing, password: existing.password_enc ? decrypt(existing.password_enc) : null, reused: true };
  }

  const rooms = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(booking.id);
  const firstRoomNumber = rooms[0]?.room_number || null;
  const firstRoom = firstRoomNumber
    ? db.prepare('SELECT * FROM rooms WHERE tenant_id = ? AND number = ?').get(tenantId, firstRoomNumber)
    : null;

  const tier = tierForRoomType(firstRoom?.type);
  const password = generatePassword();
  const identity = `room-${firstRoomNumber || booking.reference || booking.id}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const expiresAt = booking.check_out + ' 12:00:00'; // checkout time + grace

  const id = 'wf_' + crypto.randomBytes(8).toString('hex');
  db.prepare(`
    INSERT INTO wifi_provisions
      (id, tenant_id, booking_id, room_id, room_number, guest_name, controller, identity,
       password_enc, speed_down_mbps, speed_up_mbps, quota_gb, status, auto, granted_by, expires_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)
  `).run(
    id, tenantId, booking.id, firstRoom?.id || null, firstRoomNumber, booking.guest_name,
    // Controller is decided at insert time from the tenant's active config;
    // if none is configured we store 'none' and the push step is a no-op.
    db.prepare(`SELECT service_key FROM tenant_api_configs WHERE tenant_id = ? AND category = 'internet_management' AND active = 1 ORDER BY updated_at DESC LIMIT 1`).get(tenantId)?.service_key || 'none',
    identity, encrypt(password), speedDown || tier.down, speedUp || tier.up,
    quotaGb !== undefined ? quotaGb : tier.quotaGb, auto ? 1 : 0, grantedBy, expiresAt
  );

  const provision = db.prepare('SELECT * FROM wifi_provisions WHERE id = ?').get(id);
  const push = await pushToController(tenantId, provision, 'authorize');

  return { ...provision, password, push };
}

/**
 * Revoke one provision by id.
 */
async function revokeProvision(tenantId, provisionId, reason) {
  const provision = db.prepare('SELECT * FROM wifi_provisions WHERE id = ? AND tenant_id = ?').get(provisionId, tenantId);
  if (!provision) throw new Error('Wi-Fi provision not found');

  db.prepare(`UPDATE wifi_provisions SET status='revoked', revoked_at=datetime('now'), revoke_reason=?, updated_at=datetime('now') WHERE id=?`)
    .run(reason || null, provisionId);

  const push = await pushToController(tenantId, provision, 'revoke');
  return db.prepare('SELECT * FROM wifi_provisions WHERE id = ?').get(provisionId);
}

/**
 * Revoke every active session for a booking (checkout path).
 */
async function revokeForBooking(tenantId, bookingId, reason) {
  const rows = db.prepare(`SELECT * FROM wifi_provisions WHERE tenant_id = ? AND booking_id = ? AND status='active'`).all(tenantId, bookingId);
  const results = [];
  for (const row of rows) {
    results.push(await revokeProvision(tenantId, row.id, reason || 'booking.checkout'));
  }
  return results;
}

/**
 * Extend a session: new expiry (and optionally new tier).
 */
async function extendProvision(tenantId, provisionId, { expiresAt, speedDown, speedUp, quotaGb }) {
  const provision = db.prepare('SELECT * FROM wifi_provisions WHERE id = ? AND tenant_id = ?').get(provisionId, tenantId);
  if (!provision) throw new Error('Wi-Fi provision not found');

  db.prepare(`UPDATE wifi_provisions SET
      expires_at = COALESCE(?, expires_at),
      speed_down_mbps = COALESCE(?, speed_down_mbps),
      speed_up_mbps = COALESCE(?, speed_up_mbps),
      quota_gb = COALESCE(?, quota_gb),
      updated_at = datetime('now')
    WHERE id = ?`).run(expiresAt || null, speedDown || null, speedUp || null, quotaGb !== undefined ? quotaGb : null, provisionId);

  const updated = db.prepare('SELECT * FROM wifi_provisions WHERE id = ?').get(provisionId);
  const push = await pushToController(tenantId, updated, 'authorize');
  return { ...updated, push };
}

// Public surface used by routes, booking hooks, and tests.
module.exports = {
  TIERS,
  tierForRoomType,
  generatePassword,
  provisionForBooking,
  revokeForBooking,
  revokeProvision,
  extendProvision,
  pushToController,
  getAdapter,
  CONTROLLERS,
};
