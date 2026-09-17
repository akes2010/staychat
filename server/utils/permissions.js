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
  'rooms.manage',
  'pricing.manage',        // floors, room categories, holidays/festive dates, room rates
  'inbox.use',
  'orders.manage',
  'pos.use',
  'pos.manage_products',
  'bookings.manage',
  'pool.use', 'pool.manage',
  'halls.use', 'halls.manage',
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
  receptionist: [
    'dashboard.view', 'rooms.manage', 'inbox.use', 'orders.manage', 'pos.use',
    'bookings.manage', 'pool.use', 'halls.use', 'housekeeping.manage',
    'maintenance.manage', 'guests.manage', 'payments.use', 'analytics.view',
    'attendance.use', 'eod.use',
  ],
  staff: ['dashboard.view', 'rooms.manage', 'housekeeping.manage', 'maintenance.manage', 'inbox.use', 'pos.use', 'orders.manage', 'attendance.use', 'eod.use'],
  cashier: ['pos.use', 'eod.use'],
  barman: ['pos.use', 'eod.use'],
  accountant: ['dashboard.view', 'accounting.view', 'accounting.manage', 'payments.use', 'analytics.view'],
  auditor: ['dashboard.view', 'accounting.view', 'analytics.view'], // read-only by construction: never granted *.manage
};

function effectivePermissions(user) {
  if (user.role === 'superadmin') return CAPABILITIES.slice();
  if (user.permissions_customized) {
    try { return JSON.parse(user.permissions || '[]'); } catch (e) { return []; }
  }
  return (ROLE_DEFAULTS[user.role] || []).slice();
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

module.exports = { CAPABILITIES, ROLE_DEFAULTS, effectivePermissions, hasPermission, requirePermission };
