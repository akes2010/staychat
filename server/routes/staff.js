// server/routes/staff.js
const express = require('express');
const { nanoid } = require('nanoid');
const { hashPassword } = require('../utils/password-pool'); // bcrypt runs OFF the request thread
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM staff WHERE tenant_id = ? ORDER BY name').all(req.tenantId);
  res.json(rows);
});

router.post('/', requireRole('hotel_admin', 'superadmin'), async (req, res) => {
  const { name, role, department, shift, phone, email, createLogin } = req.body;
  if (!name || !role) return res.status(400).json({ error: 'name and role are required' });

  const id = 'staff_' + nanoid(10);
  let userId = null;

  if (createLogin && email) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (!existing) {
      userId = 'user_' + nanoid(10);
      const tempPassword = nanoid(8);
      db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, department, avatar, phone)
                  VALUES (?,?,?,?,?, 'staff', ?, ?, ?)`)
        .run(userId, req.tenantId, name, email.toLowerCase(), await hashPassword(tempPassword, 10), department || 'Front Desk',
             name.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase(), phone || null);
      res.locals.tempPassword = tempPassword; // surfaced in response below
    }
  }

  db.prepare(`INSERT INTO staff (id, tenant_id, user_id, name, role, department, shift, phone, email, status, tasks_completed, avg_time, joined_date)
              VALUES (?,?,?,?,?,?,?,?,?, 'active', 0, '—', date('now'))`)
    .run(id, req.tenantId, userId, name, role, department || 'Front Desk', shift || 'Morning', phone || null, email || null);

  const staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  audit(req, 'staff.create', 'staff', id, { name, role });
  res.status(201).json({ ...staff, tempPassword: res.locals.tempPassword || null });
});

router.patch('/:id', requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const s = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!s) return res.status(404).json({ error: 'Staff member not found' });

  const fields = ['name','role','department','shift','phone','email','status'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE staff SET ${setClause} WHERE id = @id`).run({ ...updates, id: s.id });
  const updated = db.prepare('SELECT * FROM staff WHERE id = ?').get(s.id);
  audit(req, 'staff.update', 'staff', s.id, updates);
  res.json(updated);
});

router.delete('/:id', requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const s = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!s) return res.status(404).json({ error: 'Staff member not found' });
  db.prepare('DELETE FROM staff WHERE id = ?').run(s.id);
  audit(req, 'staff.delete', 'staff', s.id);
  res.json({ ok: true });
});

module.exports = router;
