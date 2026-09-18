// server/middleware/auth.js
const { verifyAccessToken } = require('../utils/tokens');
const db = require('../db/connection');

/**
 * requireAuth — verifies the access token (from httpOnly cookie or Bearer header)
 * and attaches `req.user` = { id, role, tenantId, name }.
 */
function requireAuth(req, res, next) {
  const bearer = req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const token = req.cookies?.access_token || bearer;

  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role, tenantId: payload.tenantId, name: payload.name, permissions: payload.permissions || [] };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * requireRole(...roles) — restricts route to specific roles.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

/**
 * resolveTenant — figures out which tenant_id the current request should operate on.
 * - Superadmin may pass ?tenantId=xxx to act on behalf of a hotel (e.g. "Manage Hotel").
 * - Everyone else is locked to their own tenant_id from the JWT. This is the core
 *   tenant-isolation guarantee: no request body or query param can override it
 *   for non-superadmin roles.
 */
function resolveTenant(req, res, next) {
  if (req.user.role === 'superadmin') {
    req.tenantId = req.query.tenantId || req.body.tenantId || null;
  } else {
    if (!req.user.tenantId) return res.status(403).json({ error: 'Account is not linked to a hotel' });
    req.tenantId = req.user.tenantId;
  }
  next();
}

/**
 * requireTenant — used after resolveTenant on routes that must have a tenant context
 * (i.e. anything that isn't the superadmin tenant-management endpoints).
 */
function requireTenant(req, res, next) {
  if (!req.tenantId) return res.status(400).json({ error: 'tenantId is required' });
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (req.user.role !== 'superadmin') {
    // Machine-readable `code: 'SUSPENDED'` lets the SPA open the upgrade modal
    // instead of a dead-end error toast.
    if (tenant.status === 'suspended') return res.status(403).json({ error: 'This hotel account has been suspended', code: 'SUSPENDED' });
    if (tenant.subscription_status === 'suspended') return res.status(403).json({ error: 'This hotel\'s subscription is suspended — contact your platform provider to reactivate it', code: 'SUSPENDED' });
    if (tenant.subscription_status === 'terminated') return res.status(403).json({ error: 'This hotel\'s subscription has been terminated', code: 'SUSPENDED' });
  }
  req.tenant = tenant;
  next();
}

function audit(req, action, entityType, entityId, details) {
  try {
    const { nanoid } = require('nanoid');
    db.prepare(`INSERT INTO audit_log (id, tenant_id, user_id, action, entity_type, entity_id, details, ip_address)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run('audit_' + nanoid(10), req.tenantId || null, req.user?.id || null, action, entityType || null, entityId || null,
           details ? JSON.stringify(details) : null, req.ip);
  } catch (e) { /* never let audit logging break a request */ console.error('audit log failed', e); }
}

module.exports = { requireAuth, requireRole, resolveTenant, requireTenant, audit };
