// server/routes/superadmin.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, requireRole, audit } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, requireRole('superadmin'));

const PLAN_MRR = { starter: 29, pro: 79, enterprise: 199 };

function publicTenant(t) {
  const roomCount = db.prepare('SELECT COUNT(*) as c FROM rooms WHERE tenant_id = ?').get(t.id).c;
  return { ...t, ai_enabled: !!t.ai_enabled, wa_connected: !!t.wa_connected, roomCount,
    subscriptionStatus: t.subscription_status, planId: t.plan_id, billingCycle: t.billing_cycle, nextBillingDate: t.next_billing_date };
}

router.get('/tenants', (req, res) => {
  const rows = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  res.json(rows.map(publicTenant));
});

router.get('/overview', (req, res) => {
  const tenants = db.prepare('SELECT * FROM tenants').all();
  const totalMrr = tenants.reduce((s, t) => s + (t.mrr || 0), 0);
  const totalRooms = db.prepare('SELECT COUNT(*) as c FROM rooms').get().c;
  const activeCount = tenants.filter(t => t.status === 'active').length;
  res.json({ totalHotels: tenants.length, activeHotels: activeCount, totalMrr, totalRooms });
});

router.post('/tenants', (req, res) => {
  const { name, plan, rooms, email, country, subdomain } = req.body;
  if (!name) return res.status(400).json({ error: 'Hotel name is required' });
  if (!['starter','pro','enterprise'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

  const sub = (subdomain || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '');
  const existing = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(sub);
  if (existing) return res.status(409).json({ error: 'Subdomain already taken' });

  const id = 'tenant_' + nanoid(10);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status, country, email, mrr, ai_enabled)
              VALUES (?,?,?,?, 'active', ?,?,?, 1)`)
    .run(id, name, sub, plan, country || null, email || null, PLAN_MRR[plan] || 29);

  // Create the hotel admin login
  let tempPassword = null;
  if (email) {
    tempPassword = nanoid(10);
    db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, avatar) VALUES (?,?,?,?,?, 'hotel_admin', 'HA')`)
      .run('user_' + nanoid(10), id, 'Hotel Admin', email.toLowerCase(), bcrypt.hashSync(tempPassword, 10));
  }

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  audit(req, 'superadmin.tenant_create', 'tenant', id, { name, plan });
  res.status(201).json({ ...publicTenant(tenant), adminEmail: email || null, tempPassword });
});

router.patch('/tenants/:id', (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  // Only real, writable columns. `rooms` is NOT a column — room count is derived
  // (see publicTenant), so accepting it here would throw "no such column: rooms".
  const fields = ['name', 'plan', 'status', 'email', 'country'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  // Validate against the schema CHECK constraints so a bad value returns 400, not a 500.
  if (updates.plan !== undefined && !['starter', 'pro', 'enterprise'].includes(updates.plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  if (updates.status !== undefined && !['active', 'trial', 'suspended'].includes(updates.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (updates.plan) updates.mrr = PLAN_MRR[updates.plan] || tenant.mrr;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tenants SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: tenant.id });

  const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
  audit(req, 'superadmin.tenant_update', 'tenant', tenant.id, updates);
  res.json(publicTenant(updated));
});

router.post('/tenants/:id/suspend', (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  db.prepare(`UPDATE tenants SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`).run(tenant.id);
  audit(req, 'superadmin.tenant_suspend', 'tenant', tenant.id);
  res.json({ ok: true });
});

router.post('/tenants/:id/reactivate', (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  db.prepare(`UPDATE tenants SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(tenant.id);
  audit(req, 'superadmin.tenant_reactivate', 'tenant', tenant.id);
  res.json({ ok: true });
});

router.delete('/tenants/:id', (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  db.prepare('DELETE FROM tenants WHERE id = ?').run(tenant.id); // cascades via FK
  audit(req, 'superadmin.tenant_delete', 'tenant', tenant.id);
  res.json({ ok: true });
});

router.get('/audit-log', (req, res) => {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(rows);
});

module.exports = router;
