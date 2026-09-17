// server/routes/menu.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { hasPermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

function requireProductAccess(req, res, next) {
  if (hasPermission(req.user, 'menu.manage') || hasPermission(req.user, 'pos.manage_products')) return next();
  return res.status(403).json({ error: 'You do not have permission to manage menu/products' });
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM menu_items WHERE tenant_id = ? ORDER BY category, name').all(req.tenantId);
  res.json(rows.map(r => ({ ...r, available: !!r.available })));
});

router.post('/', requireProductAccess, (req, res) => {
  const { name, category, price, description, available, outlet, costPrice, discountPct, barcode, sku, imageUrl, stockQty, loyaltyPoints } = req.body;
  if (!name || price === undefined) return res.status(400).json({ error: 'name and price are required' });
  if (barcode) {
    const dupe = db.prepare('SELECT id FROM menu_items WHERE tenant_id = ? AND barcode = ?').get(req.tenantId, barcode);
    if (dupe) return res.status(409).json({ error: 'A product with this barcode already exists' });
  }
  const id = 'menu_' + nanoid(10);
  db.prepare(`INSERT INTO menu_items (id, tenant_id, name, category, price, description, available, outlet, cost_price, discount_pct, barcode, sku, image_url, stock_qty, loyalty_points)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, name, category || 'Mains', Number(price), description || null, available === false ? 0 : 1, outlet || 'both',
         Number(costPrice) || 0, Number(discountPct) || 0, barcode || null, sku || null, imageUrl || null, stockQty !== undefined && stockQty !== '' ? Number(stockQty) : null, Number(loyaltyPoints) || 0);
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  audit(req, 'menu.create', 'menu_item', id, { name });
  res.status(201).json({ ...item, available: !!item.available });
});

router.patch('/:id', requireProductAccess, (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });

  if (req.body.barcode) {
    const dupe = db.prepare('SELECT id FROM menu_items WHERE tenant_id = ? AND barcode = ? AND id != ?').get(req.tenantId, req.body.barcode, item.id);
    if (dupe) return res.status(409).json({ error: 'A product with this barcode already exists' });
  }

  const map = {
    name: 'name', category: 'category', price: 'price', description: 'description', outlet: 'outlet',
    costPrice: 'cost_price', discountPct: 'discount_pct', barcode: 'barcode', sku: 'sku', imageUrl: 'image_url', stockQty: 'stock_qty',
    loyaltyPoints: 'loyalty_points',
  };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  if (req.body.available !== undefined) updates.available = req.body.available ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE menu_items SET ${setClause} WHERE id = @id`).run({ ...updates, id: item.id });
  const updated = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(item.id);
  audit(req, 'menu.update', 'menu_item', item.id, updates);
  res.json({ ...updated, available: !!updated.available });
});

router.delete('/:id', requireProductAccess, (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!item) return res.status(404).json({ error: 'Menu item not found' });
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(item.id);
  audit(req, 'menu.delete', 'menu_item', item.id);
  res.json({ ok: true });
});

module.exports = router;
