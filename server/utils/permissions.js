// server/utils/permissions.js
// Central capability matrix.
//
// Fraud-sensitive modules (shifts, payments, pool, halls, room pricing) are
// split into a `.use` capability (day-to-day operation — booking, selling,
// clocking in) and a `.manage` capability (pricing, cancellation, refunds,
// inventory changes) so a front-desk operator can do their job without being
// able to quietly alter prices, cancel paid bookings, or mark things "paid."
// Only hotel_admin/superadmin get `.manage` by default.
//
// Per-user permissions are now FULLY customizable, not just additive: once an
// owner/manager edits a user's permission checklist, `users.permissions`
// becomes that user's complete capability set (users.permissions_customized
// flips to 1) and role defaults are no longer consulted for them. Until then,
// a user simply inherits their role's default set — nothing breaks for
// existing accounts that have never been customized.

const CAPABILITIES = [
  'dashboard.view',
  'billing.manage',        // see + manage Billing & Plan (plan changes, checkout) — owner/admin only
  'rooms.manage',
  'pricing.manage',        // floors, room categories, holidays/festive dates, room rates
  'inbox.use',
  'orders.manage',
  'pos.use',
  'pos.manage_products',
  'bookings.manage',
  'pool.use', 'pool.manage',
  'halls.use', 'halls.manage',
  'gym.use', 'gym.manage',
  'tables.use', 'tables.manage',
  'housekeeping.manage',
  'maintenance.manage',
  'guests.manage',
  'analytics.view',
  'staff.manage',
  'shifts.manage',
  'attendance.use',
  'eod.use', 'eod.manage',
  'menu.manage',
  'payments.use', 'payments.manage',
  'accounting.view', 'accounting.manage',
  'ai.manage',
  'printers.manage',
  'settings.manage',
  'users.manage',
];

// Defaults per role. superadmin implicitly has everything (checked separately).
const ROLE_DEFAULTS = {
  hotel_admin: CAPABILITIES.slice(),
  // NOTE: no 'billing.manage' for non-admin roles — the Billing & Plan page is
  // hidden from everyone except the hotel owner/admin (and platform superadmin).
  receptionist: [
    'dashboard.view', 'rooms.manage', 'inbox.use', 'orders.manage',
    // NOTE: no 'pos.use' — the restaurant/bar till is for cashier/barman (and
    // managers). Front desk handles ROOM bills via Payments, not POS tickets.
    'bookings.manage', 'pool.use', 'halls.use', 'gym.use', 'housekeeping.manage',
    'maintenance.manage', 'guests.manage', 'payments.use', 'analytics.view',
    'attendance.use', 'eod.use',
  ],
  staff: ['dashboard.view', 'rooms.manage', 'housekeeping.manage', 'maintenance.manage', 'inbox.use', 'pos.use', 'orders.manage', 'attendance.use', 'eod.use'],
  cashier: ['pos.use', 'eod.use'],
  barman: ['pos.use', 'eod.use'],
  // Floor staff, outlet-pinned like the till operators: a waiter works the BAR
  // terminal, a server the RESTAURANT terminal (same server-side outlet lock).
  // They take orders and clock in, but hold no pricing/manage power.
  waiter: ['pos.use', 'orders.manage', 'attendance.use', 'eod.use'],
  server: ['pos.use', 'orders.manage', 'attendance.use', 'eod.use'],
  // Front-office helper (F&B): sees the lobby picture and the seating plan,
  // works the WhatsApp line and clocks in — but no till, no pricing, no
  // money and no records to edit. Purely additive: an existing account can
  // only reach these permissions if an admin picks the porter role for it.
  porter: ['dashboard.view', 'inbox.use', 'tables.use', 'attendance.use'],
  accountant: ['dashboard.view', 'accounting.view', 'accounting.manage', 'payments.use', 'analytics.view'],
  auditor: ['dashboard.view', 'accounting.view', 'analytics.view'], // read-only by construction: never granted *.manage
};

// Admin-defined roles (Users & Permissions → Roles): the user's role key is
// looked up in the tenant's custom_roles row, whose permission list plays the
// same role ROLE_DEFAULTS plays for built-ins. Unknown keys (built-in removed,
// or no custom row) resolve to [] — exactly what `ROLE_DEFAULTS[role] || []`
// returned before, so nothing existing changes behaviour.
function customRoleDefaults(user) {
  if (!user || !user.tenant_id || !user.role) return [];
  // Lazy require: permissions.js must stay importable before the DB exists
  // (scripts, --check tools) and must not create a require cycle.
  let db;
  try { db = require('../db/connection'); } catch (e) { return []; }
  try {
    const row = db.prepare('SELECT permissions FROM custom_roles WHERE tenant_id = ? AND key = ?').get(user.tenant_id, user.role);
    if (!row) return [];
    try { return JSON.parse(row.permissions || '[]'); } catch (e) { return []; }
  } catch (e) { return []; }
}

function effectivePermissions(user) {
  if (user.role === 'superadmin') return CAPABILITIES.slice();
  if (user.permissions_customized) {
    try { return JSON.parse(user.permissions || '[]'); } catch (e) { return []; }
  }
  if (ROLE_DEFAULTS[user.role]) return ROLE_DEFAULTS[user.role].slice();
  return customRoleDefaults(user);
}

function hasPermission(user, capability) {
  if (user.role === 'superadmin') return true;
  const perms = user.permissions !== undefined ? user.permissions : effectivePermissions(user);
  return Array.isArray(perms) && perms.includes(capability);
}

/** Express middleware factory: requirePermission('pos.manage_products') */
function requirePermission(capability) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!hasPermission(req.user, capability)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action (' + capability + ')' });
    }
    next();
  };
}

module.exports = { CAPABILITIES, ROLE_DEFAULTS, effectivePermissions, customRoleDefaults, hasPermission, requirePermission };
