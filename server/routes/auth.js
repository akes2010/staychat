// server/routes/auth.js
const express = require('express');
const { hashPassword, comparePassword } = require('../utils/password-pool'); // bcrypt runs OFF the request thread
const rateLimit = require('express-rate-limit');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { signAccessToken, makeRefreshToken, hashToken } = require('../utils/tokens');
const { requireAuth, audit } = require('../middleware/auth');
const { effectivePermissions } = require('../utils/permissions');
const { startTrial, resolveState, ensurePlansSeeded, PLAN_CATALOG } = require('../services/entitlements');
const billing = require('../services/billing');
const PLAN_IDS = Object.keys(PLAN_CATALOG);

const router = express.Router();

// ── Rate Limiting ──────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // per-IP attempts per window. All staff often share ONE office IP
  // (NAT behind the router), so a tiny per-IP cap (5) locked out the whole
  // hotel — including the super admin — the moment a few passwords were
  // mistyped or a tab retry-storm hit during a deploy. Still stops brute
  // force outright: 30 tries * spread over 15 min is far below any
  // practical bcrypt-cracking rate, and successful logins don't count.
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
  message: { error: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  // Every tab restores its session on load and dedicated auto-refresh paths
  // (api.js on 401, ws-client.js on WS 4001) all funnel through here, so a
  // NAT'd office where everyone opens the dashboard at shift start easily
  // burst-past a small cap — and a 429 here makes the SPA look "blank":
  // the shell renders but every data call fails with 'Not authenticated'.
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  // A REFUSED refresh (no/expired cookie) is noise, not abuse — don't let it
  // consume the budget of the tabs that have a valid cookie.
  skipFailedRequests: true,
  message: { error: 'Too many refresh attempts. Please slow down.' },
});

// ── Cookie Options ─────────────────────────────────────────────────────────
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'strict', // Changed from 'lax' for better security
  secure: process.env.NODE_ENV === 'production',
  path: '/',
  domain: process.env.COOKIE_DOMAIN, // Optional: set specific domain in production
};

// ── Validation Helpers ────────────────────────────────────────────────────
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12; // Increased from 10 for better security

/**
 * Validate email format
 */
function isValidEmail(email) {
  return EMAIL_REGEX.test(email);
}

/**
 * Validate password strength
 * Requires: 8+ chars, uppercase, lowercase, number, special char
 */
function isStrongPassword(password) {
  if (!password || password.length < 8) {
    return { valid: false, reason: 'Password must be at least 8 characters' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one lowercase letter' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one number' };
  }
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    return { valid: false, reason: 'Password must contain at least one special character' };
  }
  return { valid: true };
}

/**
 * Sanitize string input - prevents XSS
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[<>]/g, '');
}

// ── User Serialization ────────────────────────────────────────────────────
function publicUser(u) {
  return {
    id: u.id,
    name: sanitizeString(u.name),
    email: u.email.toLowerCase(),
    role: u.role,
    tenantId: u.tenant_id,
    avatar: u.avatar,
    department: sanitizeString(u.department) || null,
    permissions: effectivePermissions(u),
    theme: validTheme(u.theme),
  };
}

// ── Skin themes ─────────────────────────────────────────────────────────────
// Every user can pick the colour skin they work in. The list here must match
// THEMES in public/js/theme.js (client+server share one canonical set).
const THEMES = ['green', 'emerald', 'ocean', 'royal', 'crimson', 'amber', 'slate', 'rose'];
const DEFAULT_THEME = 'green';
function validTheme(t) { return THEMES.includes(t) ? t : DEFAULT_THEME; }

function tenantFor(u) {
  if (!u.tenant_id) return null;
  // subdomain rides along so the SPA can show the hotel its public booking
  // link (/book.html?hotel=<subdomain>) right after signup.
  return db.prepare('SELECT id, name, subdomain, plan, status, currency, timezone, logo FROM tenants WHERE id = ?').get(u.tenant_id) || null;
}

// Entitlements ride along on every auth payload so the SPA can badge locked
// modules and show the trial countdown without an extra round-trip.
function entitlementsFor(u) {
  if (!u.tenant_id) return null;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(u.tenant_id);
  return tenant ? resolveState(tenant) : null;
}

// ── Session Management ──────────────────────────────────────────────────────
function issueSession(res, user) {
  const accessToken = signAccessToken(user);
  const { raw, hash, expiresAt } = makeRefreshToken();
  const tokenId = 'rt_' + nanoid(16); // Longer ID for security

  // Clean up old refresh tokens (keep only last 5 per user)
  const oldTokens = db.prepare(
    'SELECT id FROM refresh_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 100 OFFSET 5'
  ).all(user.id);
  if (oldTokens.length > 0) {
    const ids = oldTokens.map(t => t.id).join(',');
    db.prepare(`DELETE FROM refresh_tokens WHERE id IN (${ids.split(',').map(() => '?').join(',')})`).run(...oldTokens.map(t => t.id));
  }

  db.prepare('INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?,?,?,?)')
    .run(tokenId, user.id, hash, expiresAt);

  res.cookie('access_token', accessToken, { ...COOKIE_OPTS, maxAge: 15 * 60 * 1000 });
  res.cookie('refresh_token', raw, { ...COOKIE_OPTS, maxAge: 30 * 24 * 60 * 60 * 1000 });
  return accessToken;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// ── Registration rate limiting (prevents automated tenant/account spam) ────
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many signup attempts. Please try again later.' },
});

function slugify(str) {
  return String(str).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'hotel';
}

// Generates a unique subdomain by appending a short random suffix on collision.
function makeUniqueSubdomain(base) {
  let candidate = slugify(base);
  let attempt = 0;
  while (db.prepare('SELECT 1 FROM tenants WHERE subdomain = ?').get(candidate)) {
    attempt += 1;
    candidate = slugify(base) + '-' + nanoid(4).toLowerCase();
    if (attempt > 10) throw new Error('Could not generate a unique subdomain');
  }
  return candidate;
}

// POST /api/auth/register — self-service signup: creates a brand-new tenant
// (hotel) plus its first user, who becomes that tenant's hotel_admin.
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const hotelName = sanitizeString(req.body.hotelName);
    const name = sanitizeString(req.body.name);
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = req.body.password;

    if (!hotelName) return res.status(400).json({ error: 'Hotel name is required' });
    if (!name) return res.status(400).json({ error: 'Your name is required' });
    if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'A valid email is required' });

    const strength = isStrongPassword(password);
    if (!strength.valid) return res.status(400).json({ error: strength.reason });

    const existing = db.prepare('SELECT 1 FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

    const subdomain = makeUniqueSubdomain(hotelName);
    const tenantId = 'tenant_' + nanoid(10);
    const userId = 'user_' + nanoid(10);
    const passwordHash = await hashPassword(password, BCRYPT_ROUNDS);

    const doRegister = db.transaction(() => {
      db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status, email, signup_source)
                  VALUES (?, ?, ?, 'starter', 'trial', ?, ?)`)
        .run(tenantId, hotelName, subdomain, email, sanitizeString(req.body.source) || 'direct');

      db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role)
                  VALUES (?, ?, ?, ?, ?, 'hotel_admin')`)
        .run(userId, tenantId, name, email, passwordHash);
    });
    doRegister();

    // Self-service SaaS onboarding: the new hotel lands on a 30-day full-feature
    // trial of the requested plan (default Starter). The booking engine is
    // enabled so a trial hotel can exercise the whole funnel end-to-end.
    const requestedPlan = PLAN_IDS.includes(req.body.plan) ? req.body.plan : 'starter';
    const trialEndsAt = startTrial(tenantId, requestedPlan);
    ensurePlansSeeded();
    db.prepare(`INSERT INTO booking_engine_config (tenant_id, enabled) VALUES (?, 1)
                ON CONFLICT(tenant_id) DO UPDATE SET enabled = 1`).run(tenantId);
    // Starter inventory so the trial is instantly OPERABLE, not an empty shell:
    // a floor, room categories with tiered rates, and 8 real rooms (2 suites,
    // 4 standard, 2 deluxe) the desk can book, check in and settle today.
    seedStarterWorkspace(tenantId);
    billing.logEvent(tenantId, 'trial.started', '30-day trial of the ' + requestedPlan + ' plan started (ends ' + trialEndsAt + ')');

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const accessToken = issueSession(res, user);
    audit(req, 'register', 'tenant', tenantId, { hotelName, subdomain, email });

    // Welcome email — fire-and-forget; signup must never wait on (or fail
    // because of) the email provider. Skipped silently when email isn't
    // configured.
    try {
      const emailSvc = require('../services/email');
      emailSvc.sendEmail({ to: email, ...emailSvc.signupWelcomeEmail({
        hotelName, ownerName: name, subdomain, plan: requestedPlan, trialEndsAt,
      }) }).catch(() => {});
    } catch (e) { /* never block signup on email */ }

    res.status(201).json({ user: publicUser(user), tenant: tenantFor(user), accessToken, entitlements: entitlementsFor(user), trialEndsAt });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Could not create your account. Please try again.' });
  }
});

function seedStarterWorkspace(tenantId) {
  const floorId = 'flr_' + nanoid(10);
  db.prepare('INSERT INTO floors (id, tenant_id, name, number) VALUES (?,?,?,?)')
    .run(floorId, tenantId, 'Ground Floor', 1);
  const insCat = db.prepare('INSERT INTO room_categories (id, tenant_id, name, description, weekday_rate, weekend_rate, holiday_rate, festive_rate, capacity, amenities, active) VALUES (?,?,?,?,?,?,?,?,?,?,1)');
  const catStd = 'cat_' + nanoid(10), catDlx = 'cat_' + nanoid(10), catSui = 'cat_' + nanoid(10);
  insCat.run(catStd, tenantId, 'Standard Room', 'Cozy standard double', 35, 42, 50, 50, 2, '["AC","WiFi","TV"]');
  insCat.run(catDlx, tenantId, 'Deluxe Room', 'Larger room, city view', 55, 65, 75, 75, 3, '["AC","WiFi","TV","Mini bar"]');
  insCat.run(catSui, tenantId, 'Executive Suite', 'Living area + bedroom', 85, 100, 115, 115, 4, '["AC","WiFi","TV","Mini bar","Lounge"]');
  const insRoom = db.prepare('INSERT INTO rooms (id, tenant_id, number, type, view, floor, rate, capacity, status, amenities, floor_id, category_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const rooms = [
    ['101','Standard','Courtyard','Standard',35,2,catStd], ['102','Standard','Courtyard','Standard',35,2,catStd],
    ['103','Standard','Parking','Standard',35,2,catStd], ['104','Standard','Parking','Standard',35,2,catStd],
    ['105','Deluxe','City','Deluxe',55,3,catDlx], ['106','Deluxe','City','Deluxe',55,3,catDlx],
    ['201','Suite','Poolside','Executive',85,4,catSui], ['202','Suite','Poolside','Executive',85,4,catSui],
  ];
  rooms.forEach(r => insRoom.run('room_' + nanoid(10), tenantId, r[0], r[1], r[2], r[3], r[4], r[5], 'available', '["AC","WiFi"]', floorId, r[6]));
}

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    
    // Input validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(normalizedEmail);
    
    // Use constant-time comparison to prevent timing attacks
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    const passwordMatch = await comparePassword(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    
    const accessToken = issueSession(res, user);
    audit(req, 'login', 'user', user.id, { method: 'password' });

    res.json({ user: publicUser(user), tenant: tenantFor(user), accessToken, entitlements: entitlementsFor(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'An error occurred during login' });
  }
});

// POST /api/auth/demo — one-click demo accounts (role-based).
// SECURITY: this issues a fully-authenticated session with NO credentials, so it
// must never be reachable in a real deployment. It is disabled unless explicitly
// opted in via DEMO_MODE=true, and always disabled when NODE_ENV=production.
const DEMO_LOGIN_ENABLED = process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
router.post('/demo', loginLimiter, (req, res) => {
  if (!DEMO_LOGIN_ENABLED) return res.status(404).json({ error: 'Not found' });

  const { role } = req.body;
  const allowed = ['superadmin', 'hotel_admin', 'receptionist', 'staff', 'cashier', 'barman'];
  if (!allowed.includes(role)) return res.status(400).json({ error: 'Invalid demo role' });

  const user = db.prepare('SELECT * FROM users WHERE role = ? ORDER BY created_at ASC LIMIT 1').get(role);
  if (!user) return res.status(404).json({ error: 'No demo account available for that role. Run the seed script.' });

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
  const accessToken = issueSession(res, user);
  audit(req, 'login', 'user', user.id, { method: 'demo', role });
  res.json({ user: publicUser(user), tenant: tenantFor(user), accessToken });
});

// POST /api/auth/refresh
router.post('/refresh', refreshLimiter, async (req, res) => {
  try {
    const raw = req.cookies?.refresh_token;
    if (!raw) return res.status(401).json({ error: 'No refresh token' });

    const hash = hashToken(raw);
    const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0').get(hash);
    
    if (!row || new Date(row.expires_at) < new Date()) {
      // Clear cookies on invalid token
      res.clearCookie('access_token', COOKIE_OPTS);
      res.clearCookie('refresh_token', COOKIE_OPTS);
      return res.status(401).json({ error: 'Refresh token expired or invalid' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user || !user.active) {
      db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?').run(row.id);
      return res.status(401).json({ error: 'Account inactive' });
    }

    // Rotate: revoke old, issue new. The `AND revoked = 0` makes rotation
    // single-use: two concurrent refreshes with the same token (a double-clicked
    // client, or an attacker who stole it) cannot both succeed — the loser gets
    // changes=0 and is treated as a replay.
    const rotated = db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE id = ? AND revoked = 0').run(row.id);
    if (rotated.changes === 0) {
      // A refresh token must be presented exactly once. Seeing it again means
      // either a race or a replay of a stolen token — the safe response is to
      // revoke every session for the user and force a fresh login.
      db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(row.user_id);
      res.clearCookie('access_token', COOKIE_OPTS);
      res.clearCookie('refresh_token', COOKIE_OPTS);
      return res.status(401).json({ error: 'Refresh token already used — all sessions revoked for safety. Please log in again.' });
    }
    const accessToken = issueSession(res, user);
    res.json({ user: publicUser(user), tenant: tenantFor(user), accessToken, entitlements: entitlementsFor(user) });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'An error occurred during token refresh' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const raw = req.cookies?.refresh_token;
  if (raw) {
    const hash = hashToken(raw);
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?').run(hash);
  }
  res.clearCookie('access_token', COOKIE_OPTS);
  res.clearCookie('refresh_token', COOKIE_OPTS);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let tenant = null;
  if (user.tenant_id) tenant = db.prepare('SELECT id, name, plan, status, currency, timezone FROM tenants WHERE id = ?').get(user.tenant_id);
  res.json({ user: publicUser(user), tenant, entitlements: entitlementsFor(user) });
});

// PATCH /api/auth/theme — save the signed-in user's skin theme.
// Body: { theme: 'ocean' } — validated against the canonical THEMES list so a
// forged value can never inject CSS. Returns the normalized theme.
router.patch('/theme', requireAuth, (req, res) => {
  const theme = req.body && typeof req.body.theme === 'string' ? req.body.theme.toLowerCase() : '';
  if (!THEMES.includes(theme)) {
    return res.status(400).json({ error: 'Unknown theme. Choose one of: ' + THEMES.join(', ') });
  }
  db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, req.user.id);
  res.json({ theme });
});

// GET /api/auth/theme — the caller's current skin (handy after a reload).
router.get('/theme', requireAuth, (req, res) => {
  res.json({ theme: validTheme(db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id)?.theme) });
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    
    // Validate new password strength
    const passwordCheck = isStrongPassword(newPassword);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.reason });
    }
    
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const currentMatch = await comparePassword(currentPassword, user.password_hash);
    if (!currentMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Hash new password
    const newHash = await hashPassword(newPassword, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    
    // Revoke all refresh tokens (force re-login everywhere)
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    
    audit(req, 'password.change', 'user', user.id);
    
    res.json({ ok: true, message: 'Password changed successfully. Please log in again on other devices.' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'An error occurred while changing password' });
  }
});

// ── Self-service password reset ("forgot password") ───────────────────────
// POST /api/auth/forgot-password { email }
// Always answers { ok: true } — never reveals whether an account exists.
// Rate limited to 3/hour/IP; a user can only have one unused reset at a time
// (an older unused token is superseded).
const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many password-reset requests. Please try again later or contact support.' },
});

router.post('/forgot-password', forgotLimiter, async (req, res) => {
  try {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);

    if (user) {
      // Supersede any previous unused reset for this user.
      db.prepare('DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL').run(user.id);

      const rawToken = nanoid(48);            // sent in the link only
      const tokenHash = hashToken(rawToken);  // what we store (sha256)
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
      db.prepare('INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?,?,?,?)')
        .run('pwr_' + nanoid(10), user.id, tokenHash, expiresAt);

      const base = (process.env.APP_URL || billing.resolvePlatformBaseUrl(req)).replace(/\/+$/, '');
      const resetUrl = base + '/reset-password.html?token=' + rawToken;
      const emailSvc = require('../services/email');
      emailSvc.sendEmail({ to: email, ...emailSvc.passwordResetEmail({
        name: user.name, resetUrl, expiresInMinutes: 60,
      }) }).catch(() => {});
      audit(req, 'password.reset_requested', 'user', user.id);
    }

    // Same response either way — no account enumeration.
    res.json({ ok: true, message: 'If that email belongs to an account, a reset link is on its way. Check your inbox (and spam).' });
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.status(500).json({ error: 'Could not process the request. Please try again.' });
  }
});

// POST /api/auth/reset-password { token, newPassword }
router.post('/reset-password', forgotLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Reset token is required' });
    const passwordCheck = isStrongPassword(newPassword);
    if (!passwordCheck.valid) return res.status(400).json({ error: passwordCheck.reason });

    const tokenHash = hashToken(String(token));
    const reset = db.prepare(
      `SELECT r.*, u.email, u.name AS user_name FROM password_resets r
       JOIN users u ON u.id = r.user_id
       WHERE r.token_hash = ? AND r.used_at IS NULL`
    ).get(tokenHash);
    if (!reset) return res.status(400).json({ error: 'This reset link is invalid or was already used. Request a new one.' });
    if (new Date(reset.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link has expired. Request a new one — links are valid for one hour.' });
    }

    const newHash = await hashPassword(newPassword, BCRYPT_ROUNDS);
    const doReset = db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, reset.user_id);
      db.prepare('UPDATE password_resets SET used_at = datetime(\'now\') WHERE id = ?').run(reset.id);
      // Kill every existing session — the password just changed.
      db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(reset.user_id);
    });
    doReset();

    audit({ user: { id: reset.user_id }, tenantId: null, ip: req.ip }, 'password.reset_completed', 'user', reset.user_id);
    res.json({ ok: true, message: 'Password updated. You can now log in with your new password.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: 'Could not reset the password. Please try again.' });
  }
});

module.exports = router;
