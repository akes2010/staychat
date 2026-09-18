// server/services/platform-settings.js
// Platform-operator (superadmin) configuration store, backed by the
// platform_settings key/value table.
//
// This is where the PLATFORM's own payment gateway credentials live — the keys
// that power automated subscription checkout for every hotel on the platform.
// They are deliberately separate from the per-tenant gateway keys (tenants.paystack_*)
// which hotels use to charge their own guests.
//
// Secrets are encrypted at rest with AES-256-GCM (server/utils/crypto-store.js)
// and are never returned in full by any route — only a masked shape.
'use strict';

const db = require('../db/connection');
const { encrypt, decrypt, isEncrypted } = require('../utils/crypto-store');

const SECRET_KEYS = new Set([
  'stripe_secret_key',
  'paystack_secret_key',
  'flutterwave_secret_key',
]);

// Keys the superadmin console may see (masked). Anything not listed here is
// internal — e.g. the cached webhook endpoint secret after verification.
const VISIBLE_KEYS = ['stripe_secret_key', 'paystack_secret_key', 'flutterwave_secret_key', 'platform_base_url'];

function get(key) {
  const row = db.prepare('SELECT value FROM platform_settings WHERE key = ?').get(key);
  if (!row || row.value == null) return null;
  if (SECRET_KEYS.has(key) && isEncrypted(row.value)) {
    try { return decrypt(row.value); } catch (e) { return null; } // wrong/corrupted key → treat as unset
  }
  return row.value;
}

function set(key, value) {
  const stored = value == null || value === ''
    ? null
    : (SECRET_KEYS.has(key) ? encrypt(String(value)) : String(value));
  db.prepare(`INSERT INTO platform_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(key, stored);
}

function has(key) {
  return get(key) != null && get(key) !== '';
}

function isSecretKey(key) {
  return SECRET_KEYS.has(key);
}

// Masked view for the superadmin console. Secrets render as `sk_…abcd`-style
// hints plus a boolean, never the value itself.
function visibleSettings() {
  const out = {};
  for (const key of VISIBLE_KEYS) {
    const value = get(key);
    if (SECRET_KEYS.has(key)) {
      out[key] = {
        set: value != null && value !== '',
        hint: value ? String(value).slice(0, 3) + '…' + String(value).slice(-4) : null,
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { get, set, has, isSecretKey, visibleSettings };
