// server/routes/fitness.js
// Gym & Pool memberships — quarterly registrations and combined Gym & Pool
// plans with month / quarter / year pricing, features and benefits.
//
// This is a SELF-CONTAINED, ADDITIVE module:
//   • It owns two new tables (membership_plans, memberships) created
//     idempotently at load — the same pattern services/selfhost.js uses — so
//     server/db/migrate.js is not touched and no existing table changes.
//   • The legacy gym_bookings (daily/monthly/yearly) and pool_bookings
//     modules keep working exactly as before; nothing here writes to them.
//   • One mounting line in server/index.js (`app.use('/api/fitness', …)`)
//     is the only touch-point in existing server code.
//
// Permissions mirror the gym/pool conventions: anyone with gym.use or
// pool.use can register members; plan management, price/paid overrides and
// cancellations require gym.manage or pool.manage. Entitlements follow the
// platform catalog: the starter plan carries neither gym_bookings nor
// pool_bookings, pro/enterprise carry both — a registration's scope decides
// which feature is required.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { hasPermission } = require('../utils/permissions');
const { resolveState, FEATURE_LABELS, suggestedPlanFor } = require('../services/entitlements');
const { broadcast } = require('../ws');

const router = express.Router();

// ── Schema (idempotent, runs at load — no changes to server/db/migrate.js) ──
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS membership_plans (
      id TEXT PRIMARY KEY,                     -- mplan_<nanoid>
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'both' CHECK(scope IN ('gym','pool','both')),
      price_daily REAL NOT NULL DEFAULT 0,     -- daily pass price (per day)
      price_monthly REAL NOT NULL DEFAULT 0,
      price_quarterly REAL NOT NULL DEFAULT 0,
      price_yearly REAL NOT NULL DEFAULT 0,
      features TEXT NOT NULL DEFAULT '[]',     -- JSON string[] — what's included
      benefits TEXT NOT NULL DEFAULT '[]',     -- JSON string[] — member perks
      active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_membership_plans_tenant ON membership_plans(tenant_id, active);

    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,                     -- fit_<nanoid>
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES membership_plans(id) ON DELETE SET NULL,
      scope TEXT NOT NULL DEFAULT 'both' CHECK(scope IN ('gym','pool','both')),
      duration TEXT NOT NULL CHECK(duration IN ('daily','monthly','quarterly','yearly')),
      member_name TEXT NOT NULL,
      member_phone TEXT,
      member_email TEXT,
      room_number TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,                  -- inclusive, derived from duration
      amount REAL NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id, status, start_date);
  `);
  // ── Upgrades for DBs built by the pre-daily version of THIS module ────
  // (own tables only — server/db/migrate.js and every system table stay put.)
  const planCols = db.pragma('table_info(membership_plans)').map(c => c.name);
  if (!planCols.includes('price_daily')) {
    db.exec(`ALTER TABLE membership_plans ADD COLUMN price_daily REAL NOT NULL DEFAULT 0`);
  }
  upgradeDurationConstraint();
}

// SQLite cannot ALTER a CHECK constraint: a pre-daily memberships table
// rejects duration='daily', so rebuild this module's own table preserving
// every row (drop index → rename → recreate with the wider CHECK → copy →
// drop → re-index), all inside one transaction.
function upgradeDurationConstraint() {
  const meta = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='memberships'`).get();
  if (!meta || !meta.sql || meta.sql.includes("'daily'")) return;
  db.exec('BEGIN');
  try {
    db.exec('DROP INDEX IF EXISTS idx_memberships_tenant');
    db.exec('ALTER TABLE memberships RENAME TO memberships_predaily');
    db.exec(`CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_id TEXT REFERENCES membership_plans(id) ON DELETE SET NULL,
      scope TEXT NOT NULL DEFAULT 'both' CHECK(scope IN ('gym','pool','both')),
      duration TEXT NOT NULL CHECK(duration IN ('daily','monthly','quarterly','yearly')),
      member_name TEXT NOT NULL,
      member_phone TEXT,
      member_email TEXT,
      room_number TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      paid INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO memberships (id, tenant_id, plan_id, scope, duration, member_name, member_phone, member_email, room_number,
              start_date, end_date, amount, paid, status, notes, created_by, created_at, updated_at)
            SELECT id, tenant_id, plan_id, scope, duration, member_name, member_phone, member_email, room_number,
                   start_date, end_date, amount, paid, status, notes, created_by, created_at, updated_at
              FROM memberships_predaily`);
    db.exec('DROP TABLE memberships_predaily');
    db.exec('CREATE INDEX IF NOT EXISTS idx_memberships_tenant ON memberships(tenant_id, status, start_date)');
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (x) { /* nothing open */ }
    throw e;
  }
}
ensureSchema();
// Re-run on every route entry too (cheap no-op after first run) so a wiped DB
// re-created mid-process still works — same trick as services/selfhost.js.
function ensureSchemaSoft() { try { ensureSchema(); } catch (e) { /* race with concurrent boot */ } }

// ── Gates ───────────────────────────────────────────────────────────────
const SCOPES = ['gym', 'pool', 'both'];
const DURATIONS = ['daily', 'monthly', 'quarterly', 'yearly'];

function hasFitnessUse(user) { return hasPermission(user, 'gym.use') || hasPermission(user, 'pool.use'); }
function hasFitnessManage(user) { return hasPermission(user, 'gym.manage') || hasPermission(user, 'pool.manage'); }

function requireFitnessUse(req, res, next) {
  if (!hasFitnessUse(req.user)) {
    return res.status(403).json({ error: 'You don\'t have permission to manage gym or pool memberships' });
  }
  next();
}

// Permissions are fully customizable per user, so a pool-only manager
// (pool.manage without gym.manage) must still be able to manage combined
// plans — the gate is gym.manage OR pool.manage, like hasFitnessUse above.
function requireFitnessManage(req, res, next) {
  if (!hasFitnessManage(req.user)) {
    return res.status(403).json({ error: 'Only a manager or owner can manage membership plans or cancel memberships' });
  }
  next();
}

// 402 body shapes are contractual (frontend api.js opens the upgrade modal on
// UPGRADE_REQUIRED / SUSPENDED) — mirror services/entitlements.js exactly.
function requireFitnessEntitlement(req, res, next) {
  if (req.user && req.user.role === 'superadmin') {
    req.fitEnt = { gym: true, pool: true };
    return next();
  }
  const tenant = req.tenant;
  if (!tenant) return res.status(400).json({ error: 'tenantId is required' });
  const state = resolveState(tenant);
  if (state.status === 'suspended') {
    return res.status(402).json({
      error: state.pendingApproval
        ? 'Your plan activation is awaiting approval by the platform team.'
        : 'This hotel\'s subscription is not active. Upgrade or contact the platform team to reactivate.',
      code: 'SUSPENDED',
      entitlements: { planId: state.planId, planName: state.planName, status: state.status },
    });
  }
  const gym = state.features.includes('gym_bookings');
  const pool = state.features.includes('pool_bookings');
  if (!gym && !pool) {
    return res.status(402).json({
      error: `"${FEATURE_LABELS.gym_bookings}" is not part of the ${state.planName} plan.`,
      code: 'UPGRADE_REQUIRED',
      feature: 'gym_bookings',
      currentPlan: state.planId,
      upgradeTo: suggestedPlanFor('gym_bookings'),
    });
  }
  req.fitEnt = { gym, pool };
  next();
}

// A registration's scope must be entited: 'gym' needs gym_bookings,
// 'pool' needs pool_bookings, 'both' needs both.
function assertScopeEntitled(req, res, scope) {
  const e = req.fitEnt || { gym: false, pool: false };
  const missing = scope === 'both' ? (!e.gym || !e.pool) : (scope === 'gym' ? !e.gym : !e.pool);
  if (!missing) return true;
  const feature = scope === 'pool' ? 'pool_bookings' : 'gym_bookings';
  const state = resolveState(req.tenant);
  res.status(402).json({
    error: `"${FEATURE_LABELS[feature]}" is not part of the ${state.planName} plan.`,
    code: 'UPGRADE_REQUIRED',
    feature,
    currentPlan: state.planId,
    upgradeTo: suggestedPlanFor(feature),
  });
  return false;
}

router.use(requireAuth, resolveTenant, requireTenant, requireFitnessUse, requireFitnessEntitlement);

// ── Helpers ─────────────────────────────────────────────────────────────
function serializePlan(p) {
  return { ...p, active: !!p.active, features: JSON.parse(p.features || '[]'), benefits: JSON.parse(p.benefits || '[]') };
}
function serializeMembership(m) { return { ...m, paid: !!m.paid }; }

// Calendar-correct periods: monthly = +1 month − 1 day, quarterly = +3
// months − 1 day, yearly = +12 months − 1 day (all inclusive), exactly like
// the gym module's daily/monthly/yearly math.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
const DURATION_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
function periodFor(duration, start) {
  if (duration === 'daily') return { start, end: start }; // a daily pass runs one day
  return { start, end: addDays(addMonths(start, DURATION_MONTHS[duration]), -1) };
}
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }

const MAX_LIST_ITEMS = 40;
const MAX_ITEM_LEN = 160;
function sanitizeStringList(value, field) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) { const err = field + ' must be an array of strings'; throw Object.assign(new Error(err), { status: 400 }); }
  const items = value.map(v => String(v).trim()).filter(Boolean);
  if (items.length > MAX_LIST_ITEMS) { const err = field + ' may have at most ' + MAX_LIST_ITEMS + ' items'; throw Object.assign(new Error(err), { status: 400 }); }
  if (items.some(v => v.length > MAX_ITEM_LEN)) { const err = field + ' items may be at most ' + MAX_ITEM_LEN + ' characters'; throw Object.assign(new Error(err), { status: 400 }); }
  return items;
}
function sanitizePrice(value, field) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!isFinite(n) || n < 0) { const err = field + ' must be a number ≥ 0'; throw Object.assign(new Error(err), { status: 400 }); }
  return n;
}

// ── Plans (month / quarter / year pricing + features + benefits) ────────
// GET /api/fitness/plans?scope=gym|pool|both&active=true
router.get('/plans', (req, res) => {
  ensureSchemaSoft();
  let sql = 'SELECT * FROM membership_plans WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (req.query.scope) {
    if (!SCOPES.includes(req.query.scope)) return res.status(400).json({ error: 'scope must be gym, pool or both' });
    sql += ' AND scope = ?'; params.push(req.query.scope);
  }
  if (req.query.active === 'true') sql += ' AND active = 1';
  sql += ' ORDER BY name';
  res.json(db.prepare(sql).all(...params).map(serializePlan));
});

// POST /api/fitness/plans — managers only (same pricing-authority rule as gyms)
router.post('/plans', requireFitnessManage, (req, res) => {
  ensureSchemaSoft();
  const { name, scope } = req.body;
  try {
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    if (String(name).trim().length > 80) return res.status(400).json({ error: 'name may be at most 80 characters' });
    if (scope !== undefined && !SCOPES.includes(scope)) return res.status(400).json({ error: 'scope must be gym, pool or both' });
    const priceDaily = sanitizePrice(req.body.priceDaily, 'priceDaily') ?? 0;
    const priceMonthly = sanitizePrice(req.body.priceMonthly, 'priceMonthly') ?? 0;
    const priceQuarterly = sanitizePrice(req.body.priceQuarterly, 'priceQuarterly') ?? 0;
    const priceYearly = sanitizePrice(req.body.priceYearly, 'priceYearly') ?? 0;
    const features = sanitizeStringList(req.body.features, 'features') ?? [];
    const benefits = sanitizeStringList(req.body.benefits, 'benefits') ?? [];

    const id = 'mplan_' + nanoid(10);
    db.prepare(`INSERT INTO membership_plans (id, tenant_id, name, scope, price_daily, price_monthly, price_quarterly, price_yearly, features, benefits, active, created_by)
                VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`)
      .run(id, req.tenantId, String(name).trim(), scope || 'both', priceDaily, priceMonthly, priceQuarterly, priceYearly,
           JSON.stringify(features), JSON.stringify(benefits), req.user.name);
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(id);
    audit(req, 'membership_plan.create', 'membership_plan', id, { name: plan.name, scope: plan.scope });
    broadcast(req.tenantId, 'fitness.plan.created', serializePlan(plan));
    res.status(201).json(serializePlan(plan));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
});

router.patch('/plans/:id', requireFitnessManage, (req, res) => {
  ensureSchemaSoft();
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  try {
    const updates = {};
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
      if (String(req.body.name).trim().length > 80) return res.status(400).json({ error: 'name may be at most 80 characters' });
      updates.name = String(req.body.name).trim();
    }
    if (req.body.scope !== undefined) {
      if (!SCOPES.includes(req.body.scope)) return res.status(400).json({ error: 'scope must be gym, pool or both' });
      updates.scope = req.body.scope;
    }
    const pd = sanitizePrice(req.body.priceDaily, 'priceDaily'); if (pd !== undefined) updates.price_daily = pd;
    const pm = sanitizePrice(req.body.priceMonthly, 'priceMonthly'); if (pm !== undefined) updates.price_monthly = pm;
    const pq = sanitizePrice(req.body.priceQuarterly, 'priceQuarterly'); if (pq !== undefined) updates.price_quarterly = pq;
    const py = sanitizePrice(req.body.priceYearly, 'priceYearly'); if (py !== undefined) updates.price_yearly = py;
    const features = sanitizeStringList(req.body.features, 'features'); if (features !== undefined) updates.features = JSON.stringify(features);
    const benefits = sanitizeStringList(req.body.benefits, 'benefits'); if (benefits !== undefined) updates.benefits = JSON.stringify(benefits);
    if (req.body.active !== undefined) updates.active = req.body.active ? 1 : 0;
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE membership_plans SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: plan.id });
    const updated = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(plan.id);
    audit(req, 'membership_plan.update', 'membership_plan', plan.id, updates);
    broadcast(req.tenantId, 'fitness.plan.updated', serializePlan(updated));
    res.json(serializePlan(updated));
  } catch (e) {
    if (e.status === 400) return res.status(400).json({ error: e.message });
    throw e;
  }
});

router.delete('/plans/:id', requireFitnessManage, (req, res) => {
  ensureSchemaSoft();
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const activeCount = db.prepare(`SELECT COUNT(*) c FROM memberships WHERE plan_id = ? AND status = 'active'`).get(plan.id).c;
  if (activeCount > 0) return res.status(409).json({ error: 'Cannot delete a plan with active memberships — cancel them first' });
  db.prepare('DELETE FROM membership_plans WHERE id = ?').run(plan.id);
  audit(req, 'membership_plan.delete', 'membership_plan', plan.id);
  res.json({ ok: true });
});

// ── Memberships (registrations, incl. quarterly) ────────────────────────
// GET /api/fitness/memberships?status=active&scope=both
router.get('/memberships', (req, res) => {
  ensureSchemaSoft();
  let sql = 'SELECT * FROM memberships WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (req.query.status) {
    if (!['active', 'completed', 'cancelled'].includes(req.query.status)) return res.status(400).json({ error: 'status must be active, completed or cancelled' });
    sql += ' AND status = ?'; params.push(req.query.status);
  }
  if (req.query.scope) {
    if (!SCOPES.includes(req.query.scope)) return res.status(400).json({ error: 'scope must be gym, pool or both' });
    sql += ' AND scope = ?'; params.push(req.query.scope);
  }
  sql += ' ORDER BY start_date ASC, created_at ASC';
  res.json(db.prepare(sql).all(...params).map(serializeMembership));
});

// POST /api/fitness/memberships — register a member on a plan for a duration.
// The amount defaults to the plan's price for the chosen duration; only a
// manager (gym.manage / pool.manage) may override it or mark it paid — the
// same pricing-authority rule as the gym and pool modules.
router.post('/memberships', (req, res) => {
  ensureSchemaSoft();
  const { planId, duration, startDate, memberName, memberPhone, memberEmail, roomNumber, amount, paid, notes } = req.body;
  if (!planId || !duration || !startDate || !memberName) {
    return res.status(400).json({ error: 'planId, duration, startDate and memberName are required' });
  }
  if (!DURATIONS.includes(duration)) return res.status(400).json({ error: 'duration must be daily, monthly, quarterly or yearly' });
  if (!validDate(startDate)) return res.status(400).json({ error: 'startDate must be a valid YYYY-MM-DD date' });

  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ?').get(planId, req.tenantId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  if (!plan.active) return res.status(409).json({ error: plan.name + ' is not accepting new registrations right now' });
  if (!assertScopeEntitled(req, res, plan.scope)) return;

  const period = periodFor(duration, startDate);
  const canPrice = hasFitnessManage(req.user);
  const defaultPrice = Number(plan['price_' + duration]) || 0;
  const finalAmount = (canPrice && amount !== undefined) ? Number(amount) || 0 : defaultPrice;
  const finalPaid = canPrice && paid ? 1 : 0;

  const id = 'fit_' + nanoid(10);
  db.prepare(`INSERT INTO memberships (id, tenant_id, plan_id, scope, duration, member_name, member_phone, member_email, room_number,
              start_date, end_date, amount, paid, status, notes, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, plan.id, plan.scope, duration, String(memberName).trim(), memberPhone || null, memberEmail || null,
         roomNumber || null, period.start, period.end, finalAmount, finalPaid, 'active', notes || null, req.user.name);

  const membership = db.prepare('SELECT * FROM memberships WHERE id = ?').get(id);
  audit(req, 'membership.create', 'membership', id, { memberName, planId, duration, scope: plan.scope });
  broadcast(req.tenantId, 'fitness.membership.created', serializeMembership(membership));
  res.status(201).json(serializeMembership(membership));
});

// PATCH /api/fitness/memberships/:id — contact fields & notes for desk staff;
// amount/paid/status/duration/startDate/planId require pricing authority.
router.patch('/memberships/:id', (req, res) => {
  ensureSchemaSoft();
  const m = db.prepare('SELECT * FROM memberships WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!m) return res.status(404).json({ error: 'Membership not found' });
  if (['completed', 'cancelled'].includes(m.status)) return res.status(409).json({ error: 'This membership is ' + m.status + ' and can no longer be edited' });

  const gateKeys = ['amount', 'paid', 'status', 'duration', 'startDate', 'planId'];
  if (gateKeys.some(k => req.body[k] !== undefined) && !hasFitnessManage(req.user)) {
    return res.status(403).json({ error: 'Only a manager or owner can change the amount, paid status, status, duration, start date or plan of a membership' });
  }

  const updates = {};
  if (req.body.memberName !== undefined) {
    if (!String(req.body.memberName).trim()) return res.status(400).json({ error: 'memberName cannot be empty' });
    updates.member_name = String(req.body.memberName).trim();
  }
  if (req.body.memberPhone !== undefined) updates.member_phone = req.body.memberPhone || null;
  if (req.body.memberEmail !== undefined) updates.member_email = req.body.memberEmail || null;
  if (req.body.roomNumber !== undefined) updates.room_number = req.body.roomNumber || null;
  if (req.body.notes !== undefined) updates.notes = req.body.notes || null;
  if (req.body.amount !== undefined) updates.amount = sanitizePrice(req.body.amount, 'amount') ?? 0;
  if (req.body.paid !== undefined) updates.paid = req.body.paid ? 1 : 0;
  if (req.body.status !== undefined) {
    if (!['active', 'completed', 'cancelled'].includes(req.body.status)) return res.status(400).json({ error: 'status must be active, completed or cancelled' });
    updates.status = req.body.status;
  }

  let nextPlan = null;
  if (req.body.planId !== undefined || req.body.duration !== undefined) {
    nextPlan = req.body.planId !== undefined
      ? db.prepare('SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ?').get(req.body.planId, req.tenantId)
      : db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(m.plan_id);
    if (!nextPlan) return res.status(404).json({ error: 'Plan not found' });
    if (!assertScopeEntitled(req, res, nextPlan.scope)) return;
    if (req.body.planId !== undefined) { updates.plan_id = nextPlan.id; updates.scope = nextPlan.scope; }
  }    if (req.body.duration !== undefined) {
    if (!DURATIONS.includes(req.body.duration)) return res.status(400).json({ error: 'duration must be daily, monthly, quarterly or yearly' });
    updates.duration = req.body.duration;
  }
  if (req.body.startDate !== undefined) {
    if (!validDate(req.body.startDate)) return res.status(400).json({ error: 'startDate must be a valid YYYY-MM-DD date' });
    updates.start_date = req.body.startDate;
  }
  // Moving the membership re-derives the period (and the price reverts to the
  // plan's rate for the new duration unless a manager set an explicit amount).
  if (updates.duration || updates.start_date || updates.plan_id) {
    const nextDuration = updates.duration || m.duration;
    const nextStart = updates.start_date || m.start_date;
    const period = periodFor(nextDuration, nextStart);
    updates.end_date = period.end;
    if (updates.amount === undefined) {
      const sourcePlan = nextPlan || db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(m.plan_id);
      if (sourcePlan) updates.amount = Number(sourcePlan['price_' + nextDuration]) || 0;
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE memberships SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: m.id });
  const updated = db.prepare('SELECT * FROM memberships WHERE id = ?').get(m.id);
  audit(req, 'membership.update', 'membership', m.id, updates);
  broadcast(req.tenantId, 'fitness.membership.updated', serializeMembership(updated));
  res.json(serializeMembership(updated));
});

// Cancel needs pricing-level authority; completing is a day-to-day desk
// action — exactly the gym module's rule.
router.post('/memberships/:id/cancel', requireFitnessManage, (req, res) => {
  ensureSchemaSoft();
  const m = db.prepare('SELECT * FROM memberships WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!m) return res.status(404).json({ error: 'Membership not found' });
  db.prepare(`UPDATE memberships SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(m.id);
  const updated = db.prepare('SELECT * FROM memberships WHERE id = ?').get(m.id);
  audit(req, 'membership.cancel', 'membership', m.id);
  broadcast(req.tenantId, 'fitness.membership.updated', serializeMembership(updated));
  res.json(serializeMembership(updated));
});

router.post('/memberships/:id/complete', (req, res) => {
  ensureSchemaSoft();
  const m = db.prepare('SELECT * FROM memberships WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!m) return res.status(404).json({ error: 'Membership not found' });
  db.prepare(`UPDATE memberships SET status='completed', updated_at=datetime('now') WHERE id=?`).run(m.id);
  const updated = db.prepare('SELECT * FROM memberships WHERE id = ?').get(m.id);
  audit(req, 'membership.complete', 'membership', m.id);
  broadcast(req.tenantId, 'fitness.membership.updated', serializeMembership(updated));
  res.json(serializeMembership(updated));
});

module.exports = router;
