// server/utils/tenant-secrets.js
// Encryption-at-rest for the credential columns that live directly on the
// `tenants` table (WhatsApp + per-tenant payment gateway secrets).
//
// The integration-credential store (tenant_api_configs) was already encrypted
// via crypto-store; these columns were plaintext. Now every WRITE encrypts and
// every consumer DECRYPTS, with transparent backwards compatibility: legacy
// plaintext values (written before this change) still resolve until the value
// is next saved, at which point it is re-written encrypted.
//
// Never return these columns to the browser — use sanitizeTenant() on any
// serialized tenant row.
'use strict';

const { encrypt, decrypt, isEncrypted } = require('./crypto-store');

// Columns on `tenants` holding credential secrets. NOT listed: public keys,
// phone numbers, and non-credential configuration.
const SECRET_COLUMNS = [
  'wa_token',            // WhatsApp Business access token
  'wa_app_secret',       // WhatsApp webhook signature secret
  'wa_verify_token',     // WhatsApp webhook verify token (shared secret)
  'paystack_secret_key', // hotel's Paystack secret key
  'stripe_secret_key',   // hotel's Stripe secret key
];

const SECRET_COLUMNS_SQL = SECRET_COLUMNS.join(', ');

/** Encrypt all secret columns of a object (e.g. an UPDATE payload). */
function encryptTenantSecrets(obj) {
  const out = { ...obj };
  for (const col of SECRET_COLUMNS) {
    const v = out[col];
    // '' = explicit "clear" — keep as-is. Already-encrypted values stay.
    if (typeof v === 'string' && v !== '' && !isEncrypted(v)) out[col] = encrypt(v);
  }
  return out;
}

/** Decrypt all secret columns of a tenant row for internal use. */
function decryptTenantSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const col of SECRET_COLUMNS) {
    const v = out[col];
    if (typeof v === 'string' && isEncrypted(v)) {
      try {
        out[col] = decrypt(v);
      } catch (e) {
        // Wrong CREDENTIALS_ENCRYPTION_KEY or corrupted blob — the credential
        // is unusable; consumers treat "" as "not configured" (fail closed).
        out[col] = '';
      }
    }
    // Legacy plaintext passes through unchanged (still works until re-saved).
  }
  return out;
}

/** Strip secret columns entirely — for anything serialized to a client. */
function sanitizeTenant(obj) {
  const out = { ...obj };
  for (const col of SECRET_COLUMNS) delete out[col];
  return out;
}

module.exports = { SECRET_COLUMNS, SECRET_COLUMNS_SQL, encryptTenantSecrets, decryptTenantSecrets, sanitizeTenant };
