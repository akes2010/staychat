// server/routes/plans.js
// Platform surfaces: subscription plan catalog, payment gateway catalog, and
// tenant subscription lifecycle actions (assign/upgrade/downgrade/suspend/
// terminate). This manages billing STATE — it does not process real payments
// (no live Stripe/Paystack/crypto charge is made); it's the control surface
// an operator uses to reflect what was agreed/paid outside the system.
// Hosted: platform superadmin only. Desk edition: no superadmin exists — the
// hotel's own admin manages this, scoped to their own hotel.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, requirePlatformOperator, audit } = require('../middleware/auth');
const { sanitizeTenant } = require('../utils/tenant-secrets');

const router = express.Router();
router.use(requireAuth, requirePlatformOperator);

// ── Plans ────────────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  res.json(db.prepare('SELECT * FROM plans ORDER BY price_monthly ASC').all().map(p => ({ ...p, features: JSON.parse(p.features || '[]'), active: !!p.active })));
});

router.post('/plans', (req, res) => {
  const { name, description, priceMonthly, priceYearly, features } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = 'plan_' + nanoid(10);
  db.prepare('INSERT INTO plans (id, name, description, price_monthly, price_yearly, features) VALUES (?,?,?,?,?,?)')
    .run(id, name, description || null, Number(priceMonthly) || 0, Number(priceYearly) || 0, JSON.stringify(features || []));
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(id);
  audit(req, 'plan.create', 'plan', id, { name });
  res.status(201).json({ ...plan, features: JSON.parse(plan.features), active: !!plan.active });
});

router.patch('/plans/:id', (req, res) => {
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const map = { name: 'name', description: 'description', priceMonthly: 'price_monthly', priceYearly: 'price_yearly', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (req.body.features !== undefined) updates.features = JSON.stringify(req.body.features);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE plans SET ${setClause} WHERE id = @id`).run({ ...updates, id: plan.id });
  audit(req, 'plan.update', 'plan', plan.id, updates);
  const updated = db.prepare('SELECT * FROM plans WHERE id = ?').get(plan.id);
  res.json({ ...updated, features: JSON.parse(updated.features), active: !!updated.active });
});

router.delete('/plans/:id', (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) c FROM tenants WHERE plan_id = ?').get(req.params.id).c;
  if (inUse > 0) return res.status(409).json({ error: inUse + ' hotel(s) are on this plan — reassign them first' });
  db.prepare('DELETE FROM plans WHERE id = ?').run(req.params.id);
  audit(req, 'plan.delete', 'plan', req.params.id);
  res.json({ ok: true });
});

// ── Payment Gateways (superadmin-managed catalog) ───────────────────────
router.get('/gateways', (req, res) => {
  res.json(db.prepare('SELECT * FROM payment_gateways ORDER BY name').all().map(g => ({ ...g, config: JSON.parse(g.config || '{}'), active: !!g.active })));
});

router.post('/gateways', (req, res) => {
  const { name, type, description, config } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  const id = 'gw_' + nanoid(10);
  db.prepare('INSERT INTO payment_gateways (id, name, type, description, config) VALUES (?,?,?,?,?)')
    .run(id, name, type, description || null, JSON.stringify(config || {}));
  const gw = db.prepare('SELECT * FROM payment_gateways WHERE id = ?').get(id);
  audit(req, 'gateway.create', 'payment_gateway', id, { name, type });
  res.status(201).json({ ...gw, config: JSON.parse(gw.config), active: !!gw.active });
});

router.patch('/gateways/:id', (req, res) => {
  const gw = db.prepare('SELECT * FROM payment_gateways WHERE id = ?').get(req.params.id);
  if (!gw) return res.status(404).json({ error: 'Gateway not found' });
  const map = { name: 'name', type: 'type', description: 'description', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (req.body.config !== undefined) updates.config = JSON.stringify(req.body.config);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE payment_gateways SET ${setClause} WHERE id = @id`).run({ ...updates, id: gw.id });
  const updated = db.prepare('SELECT * FROM payment_gateways WHERE id = ?').get(gw.id);
  res.json({ ...updated, config: JSON.parse(updated.config), active: !!updated.active });
});

router.delete('/gateways/:id', (req, res) => {
  db.prepare('DELETE FROM payment_gateways WHERE id = ?').run(req.params.id);
  audit(req, 'gateway.delete', 'payment_gateway', req.params.id);
  res.json({ ok: true });
});

// ── Tenant subscription lifecycle ───────────────────────────────────────
// POST /api/plans/tenants/:tenantId/subscription  { planId, billingCycle, action }
// action: 'assign' | 'upgrade' | 'downgrade' | 'suspend' | 'terminate' | 'reactivate'
router.post('/tenants/:tenantId/subscription', (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.tenantId);
  if (!tenant) return res.status(404).json({ error: 'Hotel not found' });
  // A desk hotel admin can only move their OWN subscription — never another
  // hotel's (platform superadmin keeps full scope on hosted).
  if (req.user.role !== 'superadmin' && tenant.id !== req.user.tenantId) {
    return res.status(403).json({ error: 'Not your hotel' });
  }
  const { planId, billingCycle, action } = req.body;

  if (['assign', 'upgrade', 'downgrade'].includes(action)) {
    if (!planId) return res.status(400).json({ error: 'planId is required for ' + action });
    const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
    const next = new Date(); next.setMonth(next.getMonth() + (cycle === 'yearly' ? 12 : 1));
    db.prepare(`UPDATE tenants SET plan_id = ?, billing_cycle = ?, subscription_status = 'active', next_billing_date = ? WHERE id = ?`)
      .run(planId, cycle, next.toISOString().slice(0, 10), tenant.id);
    audit(req, 'tenant.subscription_' + action, 'tenant', tenant.id, { planId, cycle });
  } else if (action === 'suspend') {
    db.prepare(`UPDATE tenants SET subscription_status = 'suspended' WHERE id = ?`).run(tenant.id);
    audit(req, 'tenant.subscription_suspend', 'tenant', tenant.id);
  } else if (action === 'terminate') {
    db.prepare(`UPDATE tenants SET subscription_status = 'terminated' WHERE id = ?`).run(tenant.id);
    audit(req, 'tenant.subscription_terminate', 'tenant', tenant.id);
  } else if (action === 'reactivate') {
    db.prepare(`UPDATE tenants SET subscription_status = 'active' WHERE id = ?`).run(tenant.id);
    audit(req, 'tenant.subscription_reactivate', 'tenant', tenant.id);
  } else {
    return res.status(400).json({ error: 'Invalid action' });
  }

  // SECURITY: strip credential columns — `SELECT *` would otherwise return
  // the hotel's WhatsApp tokens / gateway secret keys in the REST response.
  res.json(sanitizeTenant(db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id)));
});

module.exports = router;
