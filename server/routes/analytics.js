// server/routes/analytics.js
const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

router.get('/summary', (req, res) => {
  const tenantId = req.tenantId;

  const rooms = db.prepare('SELECT status FROM rooms WHERE tenant_id = ?').all(tenantId);
  const occupied = rooms.filter(r => r.status === 'occupied').length;
  const occupancyPct = rooms.length ? Math.round((occupied / rooms.length) * 100) : 0;

  const todayRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount),0) as total FROM transactions
    WHERE tenant_id = ? AND status = 'completed' AND date(created_at) = date('now')
  `).get(tenantId).total;

  const posRevenueToday = db.prepare(`
    SELECT COALESCE(SUM(total),0) as total FROM pos_tickets
    WHERE tenant_id = ? AND status = 'closed' AND date(closed_at) = date('now')
  `).get(tenantId).total;
  const posOpenTickets = db.prepare(`SELECT COUNT(*) as c FROM pos_tickets WHERE tenant_id = ? AND status = 'open'`).get(tenantId).c;

  const pendingOrders = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE tenant_id = ? AND status = 'pending'`).get(tenantId).c;
  const totalOrdersToday = db.prepare(`SELECT COUNT(*) as c FROM orders WHERE tenant_id = ? AND date(created_at) = date('now')`).get(tenantId).c;

  const daily = db.prepare(`SELECT * FROM analytics_daily WHERE tenant_id = ? ORDER BY date ASC LIMIT 12`).all(tenantId);

  res.json({
    occupancyPct,
    roomsTotal: rooms.length,
    roomsOccupied: occupied,
    roomsAvailable: rooms.filter(r => r.status === 'available').length,
    roomsDirty: rooms.filter(r => r.status === 'dirty').length,
    roomsMaintenance: rooms.filter(r => r.status === 'maintenance').length,
    todayRevenue,
    posRevenueToday,
    posOpenTickets,
    pendingOrders,
    totalOrdersToday,
    dailyHistory: daily.map(d => ({ date: d.date, revenue: d.revenue, occupancyPct: d.occupancy_pct, ordersCount: d.orders_count })),
  });
});

router.get('/departments', (req, res) => {
  // Derived metrics from staff + maintenance + orders tables.
  const tenantId = req.tenantId;
  const staffByDept = db.prepare(`SELECT department, COUNT(*) as c, AVG(tasks_completed) as avgTasks FROM staff WHERE tenant_id = ? GROUP BY department`).all(tenantId);
  const maintCompletion = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM maintenance_requests WHERE tenant_id = ? AND status = 'completed') as completed,
      (SELECT COUNT(*) FROM maintenance_requests WHERE tenant_id = ?) as total
  `).get(tenantId, tenantId);

  res.json({ staffByDept, maintenanceCompletionRate: maintCompletion.total ? Math.round((maintCompletion.completed/maintCompletion.total)*100) : 100 });
});

// GET /api/analytics/engine — booking-engine submission funnel:
// volume, confirmation rate, daily submissions for the last 14 days, revenue.
router.get('/engine', (req, res) => {
  const tenantId = req.tenantId;

  const row = db.prepare(`
    SELECT
      COUNT(*) as submissions,
      COALESCE(SUM(CASE WHEN engine_sync_status = 'confirmed' THEN 1 ELSE 0 END), 0) as confirmed,
      COALESCE(SUM(CASE WHEN engine_sync_status = 'rejected' THEN 1 ELSE 0 END), 0) as rejected,
      COALESCE(SUM(CASE WHEN engine_sync_status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
      COALESCE(SUM(CASE WHEN engine_sync_status = 'confirmed' THEN total_amount ELSE 0 END), 0) as confirmedRevenue,
      COALESCE(AVG(CASE WHEN engine_sync_status IN ('confirmed','rejected') THEN total_amount END), 0) as avgValue
    FROM bookings WHERE tenant_id = ? AND source = 'engine'
  `).get(tenantId);

  const daily = db.prepare(`
    SELECT date(created_at) as date,
           COUNT(*) as submissions,
           SUM(CASE WHEN engine_sync_status = 'confirmed' THEN 1 ELSE 0 END) as confirmed
    FROM bookings
    WHERE tenant_id = ? AND source = 'engine' AND created_at >= date('now', '-13 days')
    GROUP BY date(created_at) ORDER BY date ASC
  `).all(tenantId);

  // Fill the 14-day window so the chart doesn't shift with sparse data.
  const byDate = Object.fromEntries(daily.map(r => [r.date, r]));
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const key = dt.toISOString().slice(0, 10);
    const r = byDate[key] || { submissions: 0, confirmed: 0 };
    series.push({ date: key, submissions: r.submissions, confirmed: r.confirmed });
  }

  res.json({
    submissions: row.submissions,
    confirmed: row.confirmed,
    rejected: row.rejected,
    pending: row.pending,
    confirmedRevenue: Math.round((row.confirmedRevenue || 0) * 100) / 100,
    avgValue: Math.round((row.avgValue || 0) * 100) / 100,
    // Confirmation rate over decided submissions (pending ones are still open).
    confirmRate: (row.confirmed + row.rejected) > 0
      ? Math.round((row.confirmed / (row.confirmed + row.rejected)) * 100)
      : null,
    daily: series,
  });
});

module.exports = router;
