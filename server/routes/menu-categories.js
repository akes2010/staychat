// server/routes/menu-categories.js
// Menu category vocabulary for Menu Manager / POS — the "+" feature.
//
// Categories are the groupings products live under (menu_items.category). The
// product form historically offered only a fixed list, so a category that
// wasn't already there simply could not be chosen. This module persists the
// names a manager creates on demand, per tenant, and serves them merged with
// the categories already in use by menu_items — so a fresh category stays
// selectable after a reload, on any device.
//
// Mounted at /api/menu/categories (registered BEFORE /api/menu in
// server/index.js so it can never be shadowed by a future /:id route in
// routes/menu.js — which this module deliberately leaves untouched).
const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

const MAX_LEN = 60;

// Same gate routes/menu.js applies to product writes: menu managers and POS
// product managers may extend the vocabulary; everyone else may still READ it
// (the dropdown must render for viewers too).
function requireProductAccess(req, res, next) {
  if (hasPermission(req.user, 'menu.manage') || hasPermission(req.user, 'pos.manage_products')) return next();
  return res.status(403).json({ error: 'You do not have permission to manage menu/products' });
}

// Merged vocabulary: created categories first (creation order), then any
// category in use by menu_items that isn't already listed. Deduplicated
// case-insensitively so the client never sees the same category twice.
function categoryList(tenantId) {
  const created = db.prepare('SELECT name FROM menu_categories WHERE tenant_id = ? ORDER BY created_at, name')
    .all(tenantId).map(r => r.name);
  const inUse = db.prepare('SELECT DISTINCT category FROM menu_items WHERE tenant_id = ? ORDER BY category')
    .all(tenantId).map(r => r.category).filter(Boolean);
  const out = [];
  const seen = new Set();
  [...created, ...inUse].forEach(n => {
    const k = String(n).toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(n); }
  });
  return out;
}

// GET /api/menu/categories → ["Mains", "Shisha", …]
router.get('/', (req, res) => {
  res.json(categoryList(req.tenantId));
});

// POST /api/menu/categories { name } → 201 { name } | 409 { existing } | 400
router.post('/', requireProductAccess, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().replace(/\s+/g, ' ');
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  if (name.length > MAX_LEN) {
    return res.status(400).json({ error: 'Category name must be ' + MAX_LEN + ' characters or fewer' });
  }

  // Already available? Answer 409 with the canonical-cased name so the client
  // can simply SELECT it instead of duplicating ("create if not available").
  const existing =
    db.prepare('SELECT name FROM menu_categories WHERE tenant_id = ? AND name = ? COLLATE NOCASE').get(req.tenantId, name) ||
    db.prepare('SELECT category AS name FROM menu_items WHERE tenant_id = ? AND category = ? COLLATE NOCASE').get(req.tenantId, name);
  if (existing) return res.status(409).json({ error: 'This category already exists', existing: existing.name });

  // PK is (tenant_id, name COLLATE NOCASE) — INSERT OR IGNORE turns the
  // race against a concurrent create into the same 409 instead of a 500.
  const { changes } = db.prepare('INSERT OR IGNORE INTO menu_categories (tenant_id, name, created_by) VALUES (?,?,?)')
    .run(req.tenantId, name, req.user && req.user.id ? req.user.id : null);
  if (!changes) {
    const raced = db.prepare('SELECT name FROM menu_categories WHERE tenant_id = ? AND name = ? COLLATE NOCASE').get(req.tenantId, name);
    return res.status(409).json({ error: 'This category already exists', existing: raced ? raced.name : name });
  }

  audit(req, 'menu.category_create', 'menu_category', name, { name });
  res.status(201).json({ name });
});

module.exports = router;
