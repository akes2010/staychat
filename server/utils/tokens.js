// server/utils/tokens.js
// Secure token management with required secrets validation
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { effectivePermissions } = require('./permissions');

// Token TTLs
const ACCESS_TTL = '15m';
const REFRESH_TTL_DAYS = 30;

// Validate and require secrets in production
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_SECRET || !REFRESH_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must be set in production environment');
  }
  // Fallback for development only with a warning
  console.warn('⚠️ WARNING: Using default JWT secrets. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in production!');
}

const DEV_ACCESS_SECRET = ACCESS_SECRET || 'dev_access_secret_DO_NOT_USE_IN_PRODUCTION';
const DEV_REFRESH_SECRET = REFRESH_SECRET || 'dev_refresh_secret_DO_NOT_USE_IN_PRODUCTION';

// Pre-derive the HMAC key ONCE. jsonwebtoken re-derives the key on every
// verify() — it first tries createPublicKey(secret), which THROWS for a plain
// string, then falls back to createSecretKey: two key-derivation attempts per
// request (measured ≈100µs each — visible as `createPublicKey` at
// internal/crypto/keys in the load profile). Passing a KeyObject skips both
// (jsonwebtoken checks `instanceof KeyObject` and uses it directly).
const ACCESS_KEY = crypto.createSecretKey(Buffer.from(DEV_ACCESS_SECRET, 'utf8'));

/**
 * Sign an access token with user payload
 * @param {Object} user - User object with id, role, tenant_id, name
 * @returns {string} JWT access token
 */
function signAccessToken(user) {
  const payload = {
    sub: user.id,
    role: user.role,
    tenantId: user.tenant_id || null,
    name: user.name,
    permissions: effectivePermissions(user),
    iat: Math.floor(Date.now() / 1000),
  };
  
  return jwt.sign(payload, ACCESS_KEY, {
    expiresIn: ACCESS_TTL,
    issuer: 'staychat-os',
    audience: 'staychat-app',
  });
}

/**
 * Verify and decode an access token
 * @param {string} token - JWT access token
 * @returns {Object} Decoded token payload
 * @throws {Error} If token is invalid or expired
 */
function verifyAccessToken(token) {
  try {
    return jwt.verify(token, ACCESS_KEY, {
      issuer: 'staychat-os',
      audience: 'staychat-app',
    });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new Error('Access token has expired');
    }
    if (err.name === 'JsonWebTokenError') {
      throw new Error('Invalid access token');
    }
    throw err;
  }
}

/**
 * Generate a cryptographically secure refresh token
 * Uses crypto.randomBytes for better randomness than math.random
 * @returns {Object} Object containing raw token, hash, and expiration date
 */
function makeRefreshToken() {
  // Generate 64 bytes of cryptographically secure random data
  const raw = crypto.randomBytes(64).toString('base64url');
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  
  return { raw, hash, expiresAt };
}

/**
 * Hash a token using SHA-256
 * @param {string} raw - Raw token string
 * @returns {string} Hex-encoded SHA-256 hash
 */
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Generate a secure random token for various purposes
 * @param {number} bytes - Number of random bytes (default: 32)
 * @returns {string} Base64url-encoded random token
 */
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  makeRefreshToken,
  hashToken,
  generateSecureToken,
  ACCESS_TTL,
  REFRESH_TTL_DAYS,
};
