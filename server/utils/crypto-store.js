// server/utils/crypto-store.js
// Field-level encryption for secrets stored at rest (API credentials, etc.).
//
// Uses AES-256-GCM: authenticated encryption, so tampering with the ciphertext
// is detected on decrypt rather than silently returning garbage. Each value is
// encrypted with a fresh random 96-bit IV; the stored blob is:
//
//     v1:<iv-base64>:<authTag-base64>:<ciphertext-base64>
//
// The version prefix (`v1`) lets us rotate algorithms later without guessing the
// format. `encryptJSON`/`decryptJSON` wrap a whole object (the common case: a
// credentials map) in a single blob.
'use strict';

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;      // 96-bit IV recommended for GCM
const KEY_BYTES = 32;     // 256-bit key
const VERSION = 'v1';

// ── Key derivation ──────────────────────────────────────────────────────────
// The master key comes from CREDENTIALS_ENCRYPTION_KEY. We accept either a
// 64-char hex string (32 bytes, the recommended form) or any passphrase, which
// we stretch to 32 bytes with scrypt + a fixed application salt so operators
// can't accidentally supply a too-short key.
const RAW_KEY = process.env.CREDENTIALS_ENCRYPTION_KEY;
const APP_SALT = 'staychat-os/credentials/v1'; // fixed, non-secret domain separator

if (!RAW_KEY) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: CREDENTIALS_ENCRYPTION_KEY must be set in production. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  console.warn('⚠️ WARNING: CREDENTIALS_ENCRYPTION_KEY is not set — using an insecure dev key. Stored API credentials are NOT safe. Set it before production.');
}

const DEV_KEY = 'dev_credentials_key_DO_NOT_USE_IN_PRODUCTION_00';

function deriveKey(raw) {
  // A clean 64-char hex string is used directly as 32 raw bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  // Otherwise treat it as a passphrase and stretch it.
  return crypto.scryptSync(raw, APP_SALT, KEY_BYTES);
}

const KEY = deriveKey(RAW_KEY || DEV_KEY);

/**
 * Encrypt a UTF-8 string. Returns the versioned blob string.
 */
function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/**
 * Decrypt a versioned blob back to the original string.
 * Throws if the blob is malformed or fails authentication (tampering / wrong key).
 */
function decrypt(blob) {
  if (blob == null) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unrecognized ciphertext format');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * True if a stored string looks like one of our encrypted blobs. Lets callers
 * transparently handle legacy plaintext rows written before encryption existed.
 */
function isEncrypted(value) {
  return typeof value === 'string' && /^v1:[^:]+:[^:]+:[^:]+$/.test(value);
}

/**
 * Encrypt an object as a single blob (JSON → ciphertext).
 */
function encryptJSON(obj) {
  return encrypt(JSON.stringify(obj ?? {}));
}

/**
 * Decrypt a blob back into an object. If the stored value is legacy plaintext
 * JSON (not yet encrypted), parse it directly so old rows keep working until
 * they're next saved (at which point they're re-written encrypted).
 */
function decryptJSON(blob) {
  if (blob == null) return {};
  if (!isEncrypted(blob)) {
    // Legacy plaintext row — parse as-is.
    try { return JSON.parse(blob); } catch (e) { return {}; }
  }
  try {
    return JSON.parse(decrypt(blob));
  } catch (e) {
    // Wrong key or corrupted data — surface as empty rather than crashing the
    // request; the caller (route) treats missing creds as "not configured".
    return {};
  }
}

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON, isEncrypted };
