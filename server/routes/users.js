// server/routes/users.js
// User Management & Permissions — hotel_admin/superadmin only.
// Supports creating staff with custom permissions, role changes, and account management.
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { CAPABILITIES, ROLE_DEFAULTS, effectivePermissions } = require('../utils/permissions');
const { assertLimit } = require('../services/entitlements');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requireRole('hotel_admin', 'superadmin'));

// Config
const ASSIGNABLE_ROLES = ['hotel_admin', 'receptionist', 'staff', 'cashier', 'barman', 'accountant', 'auditor'];
const BCRYPT_ROUNDS = 12;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── Validation Helpers ───────────────────────────────────────────────────────

/**
 * Validate email format
 */
function isValidEmail(email) {
  return EMAIL_REGEX.test(email);
}

/**
 * Validate password strength
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
  return { valid: true };
}

/**
 * Sanitize string input
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[<>]/g, '');
}

/**
 * Validate permissions array
 */
function validatePermissions(perms) {
  if (!Array.isArray(perms)) return false;
  return perms.every(p => typeof p === 'string' && CAPABILITIES.includes(p));
}

// ── Serialization ────────────────────────────────────────────────────────────

function serialize(u) {
  return {
    id: u.id,
    name: sanitizeString(u.name),
    email: u.email.toLowerCase(),
    role: u.role,
    department: sanitizeString(u.department) || null,
    avatar: u.avatar,
    phone: u.phone ? sanitizeString(u.phone) : null,
    active: !!u.active,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    roleDefaults: ROLE_DEFAULTS[u.role] || [],
    permissionsCustomized: !!u.permissions_customized,
    effectivePermissions: effectivePermissions(u),
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/users — list all users for the current tenant
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at ASC').all(req.tenantId);
  res.json(rows.map(serialize));
});

// GET /api/users/capabilities — the full capability catalog
router.get('/capabilities', (req, res) => {
  res.json({ capabilities: CAPABILITIES, roleDefaults: ROLE_DEFAULTS });
});

// POST /api/users — create a new user
router.post('/', async (req, res) => {
  try {
    const { name, email, password, role, department, phone, permissions } = req.body;
    
    // Validate required fields
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'name, email, password and role are required' });
    }
    
    // Validate role
    if (!ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Validate email format
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Validate password strength (unless admin is creating)
    if (req.user.role !== 'superadmin') {
      const passwordCheck = isStrongPassword(password);
      if (!passwordCheck.valid) {
        return res.status(400).json({ error: passwordCheck.reason });
      }
    }
    
    // Check for existing email
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    
    // Validate permissions if provided
    if (permissions !== undefined && !validatePermissions(permissions)) {
      return res.status(400).json({ error: 'Invalid permissions array' });
    }

    const id = 'user_' + nanoid(16);
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const avatar = name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase();
    const customized = Array.isArray(permissions);

    // SaaS seat limit — plans cap active staff logins (402 on breach).
    // Superadmins manage the platform itself and never count against a hotel's seats.
    if (req.user.role !== 'superadmin' && role !== 'superadmin') {
      const seatCount = db.prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND active = 1').get(req.tenantId).c;
      try { assertLimit(req.tenant, 'maxUsers', seatCount); }
      catch (e) { return res.status(e.status || 402).json({ error: e.message, code: e.code, limitKey: e.limitKey, limit: e.limit, upgradeTo: e.upgradeTo }); }
    }

    // The SELECT-then-INSERT above can race: two concurrent creates with the same
    // email both pass the check, and the UNIQUE constraint rejects the second
    // INSERT — which surfaced as a bare 500 instead of the 409 the caller earned.
    try {
      db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, department, avatar, phone, active, permissions, permissions_customized)
                  VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`)
        .run(id, req.tenantId, sanitizeString(name), normalizedEmail, passwordHash, role, 
             sanitizeString(department) || null, avatar, sanitizeString(phone) || null,
             JSON.stringify(customized ? permissions : []), customized ? 1 : 0);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'A user with this email already exists' });
      }
      throw e;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    audit(req, 'user.create', 'user', id, { email: normalizedEmail, role });
    res.status(201).json(serialize(user));
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// PATCH /api/users/:id — update user
router.patch('/:id', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    // Prevent self-deactivation
    if (user.id === req.user.id && req.body.active === false) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    
    // Prevent self role change
    if (user.id === req.user.id && req.body.role && req.body.role !== user.role) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }

    const updates = {};
    if (req.body.name !== undefined) updates.name = sanitizeString(req.body.name);
    if (req.body.department !== undefined) updates.department = sanitizeString(req.body.department);
    if (req.body.phone !== undefined) updates.phone = sanitizeString(req.body.phone);
    if (req.body.active !== undefined) updates.active = req.body.active ? 1 : 0;
    
    if (req.body.role !== undefined) {
      if (!ASSIGNABLE_ROLES.includes(req.body.role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.role = req.body.role;
    }
    
    // Permission customization
    if (req.body.resetPermissions) {
      updates.permissions = '[]';
      updates.permissions_customized = 0;
    } else if (req.body.permissions !== undefined) {
      if (!validatePermissions(req.body.permissions)) {
        return res.status(400).json({ error: 'Invalid permissions array' });
      }
      updates.permissions = JSON.stringify(req.body.permissions);
      updates.permissions_customized = 1;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id: user.id });

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    
    // Revoke sessions on permission/role change
    if (updates.permissions !== undefined || updates.role !== undefined) {
      db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    }
    
    audit(req, 'user.update', 'user', user.id, updates);
    res.json(serialize(updated));
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// POST /api/users/:id/reset-password — admin resets password
router.post('/:id/reset-password', async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }
    
    // Use strict password validation for admin password resets
    const passwordCheck = isStrongPassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.reason });
    }
    
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
    
    // Force re-login everywhere
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    
    audit(req, 'user.reset_password', 'user', user.id);
    res.json({ ok: true, message: 'Password has been reset. User will need to log in again.' });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// DELETE /api/users/:id — deactivate user (soft-delete)
router.delete('/:id', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (user.id === req.user.id) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }
    
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(user.id);
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(user.id);
    
    audit(req, 'user.deactivate', 'user', user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error deactivating user:', err);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

module.exports = router;
