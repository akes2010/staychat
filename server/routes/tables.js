// server/routes/tables.js
// Tables & Seating — restaurant & bar floor inventory (pos_tables). Every
// table carries its sitting setting (Standard, Booth, Window Side, Bar
// Counter, Lounge, Outdoor, VIP / Private), the number of chairs per table,
// which outlet it belongs to (location: restaurant | bar — the same outlet
// domain the POS uses) and an active flag a manager can flip without losing
// the row — mirroring the halls/pool/gym module structure.
//
// The list also carries LIVE occupancy: an open POS ticket seated at the
// table (ticket_id / covers / opened_at) so the management page doubles as a
// floor-status board. POST /bulk seeds a whole outlet at once for setup
// ("Bar Seat 1..12") without colliding with tables that already exist.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');
const { broadcast } = require('../ws');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('tables.use'), requireEntitlement('pos_tables'));

const SITTINGS = ['Standard', 'Booth', 'Window Side', 'Bar Counter', 'Lounge', 'Outdoor', 'VIP / Private'];
const LOCATIONS = ['restaurant', 'bar'];

function serializeTable(t) {
  return { ...t, active: !!t.active, occupied: !!t.ticket_id, ticket_id: t.ticket_id || null,
           covers: t.ticket_covers !== undefined ? t.ticket_covers : null, opened_at: t.opened_at || null };
}

// cleanFields(body, partial) → { error } on invalid input, else { values }
// with the cleaned fields that were supplied (partial) — a create validates
// `name` outright and lets the rest default.
function cleanFields(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    const name = String((body && body.name) || '').trim().replace(/\s+/g, ' ');
    if (!name) return { error: 'name is required' };
    if (name.length > 60) return { error: 'name must be 60 characters or fewer' };
    out.name = name;
  }
  if (body.sitting !== undefined) {
    if (!SITTINGS.includes(body.sitting)) return { error: 'sitting must be one of: ' + SITTINGS.join(', ') };
    out.sitting = body.sitting;
  }
  if (body.chairs !== undefined) {
    const chairs = Number(body.chairs);
    if (!Number.isInteger(chairs) || chairs < 1 || chairs > 50) {
      return { error: 'chairs must be a whole number between 1 and 50' };
    }
    out.chairs = chairs;
  }
  if (body.persons !== undefined) {
    const persons = Number(body.persons);
    if (!Number.isInteger(persons) || persons < 1 || persons > 50) {
      return { error: 'persons must be a whole number between 1 and 50' };
    }
    out.persons = persons;
  }
  if (body.location !== undefined) {
    if (!LOCATIONS.includes(body.location)) return { error: 'location must be restaurant or bar' };
    out.location = body.location;
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return { values: out };
}

// ── Tables (inventory + live occupancy) ───────────────────────────────────
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM pos_tables WHERE tenant_id = ? ORDER BY location, name').all(req.tenantId);
  // One open ticket per seated table (validateSeat in routes/pos.js blocks
  // double-seating) — a Map join keeps the row list flat even if a race ever
  // left two opens behind.
  const seated = db.prepare("SELECT id, table_id, covers, created_at FROM pos_tickets WHERE tenant_id = ? AND status = 'open' AND table_id IS NOT NULL")
    .all(req.tenantId);
  const byTable = new Map();
  for (const s of seated) if (!byTable.has(s.table_id)) byTable.set(s.table_id, s);
  res.json(rows.map(t => {
    const s = byTable.get(t.id);
    return serializeTable(s ? { ...t, ticket_id: s.id, ticket_covers: s.covers, opened_at: s.created_at } : t);
  }));
});

// ── Bulk setup — seed an outlet's floor in one call ────────────────────────
// Body: { location, count, prefix?, startAt?, sitting?, chairs?, persons? }.
// Names are "<prefix> <n>"; numbers that already exist in the outlet are
// SKIPPED (reported back) so re-running setup never 409s or duplicates rows.
router.post('/bulk', requirePermission('tables.manage'), (req, res) => {
  const body = req.body || {};
  const location = body.location === undefined ? 'restaurant' : body.location;
  if (!LOCATIONS.includes(location)) return res.status(400).json({ error: 'location must be restaurant or bar' });

  const count = Number(body.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return res.status(400).json({ error: 'count must be a whole number between 1 and 100' });
  }
  const startAt = body.startAt === undefined ? 1 : Number(body.startAt);
  if (!Number.isInteger(startAt) || startAt < 0 || startAt > 10000) {
    return res.status(400).json({ error: 'startAt must be a whole number between 0 and 10000' });
  }
  const prefix = String(body.prefix === undefined ? 'Table' : body.prefix).trim().replace(/\s+/g, ' ');
  if (!prefix || prefix.length > 40) return res.status(400).json({ error: 'prefix must be 1–40 characters' });

  // Sitting / chairs / persons reuse the single-table validators (partial
  // mode — `name` is generated below, so cleanFields must not demand one).
  const shaped = cleanFields({ sitting: body.sitting, chairs: body.chairs, persons: body.persons, location }, true);
  if (shaped.error) return res.status(400).json({ error: shaped.error });

  const existing = db.prepare('SELECT name FROM pos_tables WHERE tenant_id = ? AND location = ? COLLATE NOCASE')
    .all(req.tenantId, location).map(r => r.name.toLowerCase());

  const created = [];
  const skipped = [];
  const insert = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const name = (prefix + ' ' + (startAt + i)).slice(0, 60);
      if (existing.includes(name.toLowerCase())) { skipped.push(name); continue; }
      const id = 'tbl_' + nanoid(10);
      db.prepare(`INSERT INTO pos_tables (id, tenant_id, name, sitting, chairs, persons, location, active)
                  VALUES (?,?,?,?,?,?,?,1)`)
        .run(id, req.tenantId, name, shaped.values.sitting || 'Standard', shaped.values.chairs || 4,
             shaped.values.persons || 4, location);
      existing.push(name.toLowerCase()); // duplicates within the batch itself
      const table = db.prepare('SELECT * FROM pos_tables WHERE id = ?').get(id);
      created.push(serializeTable(table));
      broadcast(req.tenantId, 'table.created', serializeTable(table));
    }
  });
  insert();

  audit(req, 'tables.bulk_create', 'pos_table', null, { location, count, created: created.length, skipped: skipped.length, prefix });
  res.status(201).json({ created, skipped });
});

router.post('/', requirePermission('tables.manage'), (req, res) => {
  const { error, values } = cleanFields(req.body, false);
  if (error) return res.status(400).json({ error });

  // One name per outlet — "Table 1" may exist in the restaurant AND the bar,
  // but not twice in the same room.
  const dupe = db.prepare('SELECT id FROM pos_tables WHERE tenant_id = ? AND location = ? AND name = ? COLLATE NOCASE')
    .get(req.tenantId, values.location || 'restaurant', values.name);
  if (dupe) {
    return res.status(409).json({ error: 'A table named "' + values.name + '" already exists in the ' + (values.location || 'restaurant') });
  }

  const id = 'tbl_' + nanoid(10);
  db.prepare(`INSERT INTO pos_tables (id, tenant_id, name, sitting, chairs, persons, location, active)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, values.name, values.sitting || 'Standard', values.chairs || 4, values.persons || 4,
         values.location || 'restaurant', values.active === undefined ? 1 : values.active);
  const table = db.prepare('SELECT * FROM pos_tables WHERE id = ?').get(id);
  audit(req, 'tables.create', 'pos_table', id, { name: values.name, location: values.location || 'restaurant' });
  broadcast(req.tenantId, 'table.created', serializeTable(table));
  res.status(201).json(serializeTable(table));
});

router.patch('/:id', requirePermission('tables.manage'), (req, res) => {
  const table = db.prepare('SELECT * FROM pos_tables WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const { error, values } = cleanFields(req.body, true);
  if (error) return res.status(400).json({ error });
  if (Object.keys(values).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // The rename/move target must stay unique within its (possibly new) outlet.
  const nextName = values.name !== undefined ? values.name : table.name;
  const nextLoc = values.location !== undefined ? values.location : table.location;
  const dupe = db.prepare('SELECT id FROM pos_tables WHERE tenant_id = ? AND location = ? AND name = ? COLLATE NOCASE AND id != ?')
    .get(req.tenantId, nextLoc, nextName, table.id);
  if (dupe) {
    return res.status(409).json({ error: 'A table named "' + nextName + '" already exists in the ' + nextLoc });
  }

  const setClause = Object.keys(values).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE pos_tables SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...values, id: table.id });
  const updated = db.prepare('SELECT * FROM pos_tables WHERE id = ?').get(table.id);
  audit(req, 'tables.update', 'pos_table', table.id, values);
  broadcast(req.tenantId, 'table.updated', serializeTable(updated));
  res.json(serializeTable(updated));
});

router.delete('/:id', requirePermission('tables.manage'), (req, res) => {
  const table = db.prepare('SELECT * FROM pos_tables WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!table) return res.status(404).json({ error: 'Table not found' });
  db.prepare('DELETE FROM pos_tables WHERE id = ?').run(table.id);
  audit(req, 'tables.delete', 'pos_table', table.id, { name: table.name });
  broadcast(req.tenantId, 'table.deleted', { id: table.id });
  res.json({ ok: true });
});

module.exports = router;
