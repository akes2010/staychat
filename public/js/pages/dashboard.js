// public/js/pages/dashboard.js
window.PAGES = window.PAGES || {};

PAGES.dashboard = function () {
  const wrap = el('div', 'fa');
  wrap.innerHTML = loaderHTML('Loading dashboard…');

  (async () => {
    try {
      const [summary, rooms, orders, staffList] = await Promise.all([
        API.get('/api/analytics/summary'),
        API.get('/api/rooms'),
        API.get('/api/orders'),
        API.get('/api/staff'),
      ]);
      wrap.innerHTML = '';
      wrap.appendChild(buildDashboard(summary, rooms, orders, staffList));
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'dashboard\')');
    }
  })();

  return wrap;
};

function buildDashboard(summary, rooms, orders, staffList) {
  const pendOrders = orders.filter(o => o.status === 'pending').length;
  const canPos = typeof can === 'function' ? can('pos.use') : true;
  const root = el('div');

  root.innerHTML = '' +
  '<div class="page-header">' +
    '<div class="page-header-left"><h1>Command Center</h1><p>Welcome back, ' + escapeHtml(App.user.name) + '. ' + dateNow() + ' &middot; ' + timeNow() + '</p></div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
      '<button class="btn primary" onclick="openNewIncident()">+ New Incident</button>' +
      '<button class="btn outline" onclick="navigate(\'analytics\')">Reports</button>' +
    '</div>' +
  '</div>' +
  '<div class="grid grid-4" style="margin-bottom:20px">' +
    '<div class="metric-card" style="cursor:pointer" onclick="navigate(\'rooms\')">' +
      '<div class="metric-top"><div class="metric-icon" style="background:#e8f5e9">🛏</div><span class="metric-delta up">Live</span></div>' +
      '<div class="metric-label">Occupancy Rate</div><div class="metric-value">' + summary.occupancyPct + '%</div>' +
      '<div style="margin-top:8px">' + pbar(summary.occupancyPct, 'var(--a)') + '</div>' +
      '<div class="metric-sub">' + summary.roomsOccupied + ' of ' + summary.roomsTotal + ' rooms occupied</div>' +
    '</div>' +
    '<div class="metric-card">' +
      '<div class="metric-top"><div class="metric-icon" style="background:#eff6ff">💰</div></div>' +
      '<div class="metric-label">Revenue Today</div><div class="metric-value">' + formatMoney(summary.todayRevenue) + '</div>' +
      '<div class="metric-sub">From completed transactions</div>' +
    '</div>' +
    '<div class="metric-card" style="cursor:pointer" onclick="navigate(\'inbox\')">' +
      '<div class="metric-top"><div class="metric-icon" style="background:#f0fdf4">💬</div><div class="pulse-dot" style="width:8px;height:8px;border-radius:99px;background:var(--a)"></div></div>' +
      '<div class="metric-label">WhatsApp Inbox</div><div class="metric-value">Live</div>' +
      '<div class="metric-sub">Real-time via WebSocket</div>' +
    '</div>' +
    '<div class="metric-card" style="cursor:pointer" onclick="navigate(\'orders\')">' +
      '<div class="metric-top"><div class="metric-icon" style="background:#fffbeb">🍽</div><span class="metric-delta ' + (pendOrders > 2 ? 'down' : 'up') + '">' + pendOrders + ' pending</span></div>' +
      '<div class="metric-label">Room Service Orders</div><div class="metric-value">' + summary.totalOrdersToday + '</div>' +
      '<div class="metric-sub">Today\'s orders</div>' +
    '</div>' +
    (canPos ? '<div class="metric-card" style="cursor:pointer" onclick="navigate(\'pos\')">' +
      '<div class="metric-top"><div class="metric-icon" style="background:#fdf2f8">🧾</div><span class="metric-delta up">' + (summary.posOpenTickets || 0) + ' open</span></div>' +
      '<div class="metric-label">Point of Sale</div><div class="metric-value">' + formatMoney(summary.posRevenueToday || 0) + '</div>' +
      '<div class="metric-sub">Restaurant &amp; Bar revenue today</div>' +
    '</div>' : '') +
  '</div>' +
  '<div class="grid grid-4" style="margin-bottom:20px">' +
    [['🟢','Available',summary.roomsAvailable],['🔵','Occupied',summary.roomsOccupied],['🟡','Dirty',summary.roomsDirty],['🔴','Maintenance',summary.roomsMaintenance]].map(arr =>
      '<div class="card" style="display:flex;align-items:center;gap:14px;cursor:pointer;padding:14px 16px" onclick="navigate(\'rooms\')">' +
        '<span style="font-size:22px">' + arr[0] + '</span>' +
        '<div><div style="font-size:24px;font-weight:800;color:var(--text);letter-spacing:-.03em">' + arr[2] + '</div>' +
        '<div style="font-size:11px;color:var(--text3);font-weight:600;text-transform:uppercase">' + arr[1] + '</div></div></div>'
    ).join('') +
  '</div>' +
  '<div style="display:grid;grid-template-columns:2fr 1fr;gap:16px">' +
    '<div class="card" style="padding:0;overflow:hidden">' +
      '<div class="card-header" style="padding:14px 18px;background:var(--surface2);border-bottom:1px solid var(--border);border-radius:var(--radius-lg) var(--radius-lg) 0 0">' +
        '<div style="display:flex;align-items:center;gap:8px"><div class="pulse-dot" style="width:8px;height:8px;border-radius:99px;background:var(--a)"></div><span class="card-title">Live Ops Feed</span></div>' +
        '<button class="btn ghost sm" onclick="navigate(\'inbox\')">View All &rarr;</button>' +
      '</div>' +
      '<div id="live-feed"></div>' +
    '</div>' +
    '<div style="display:flex;flex-direction:column;gap:14px">' +
      '<div class="card"><div class="card-header"><span class="card-title">Staff Online</span><button class="btn outline sm" onclick="navigate(\'staff\')">All Staff</button></div>' +
        '<div id="staff-online-list"></div>' +
        '<button class="btn outline full sm" style="margin-top:12px" onclick="openBroadcast()">Broadcast Message</button>' +
      '</div>' +
      '<div style="background:linear-gradient(135deg,var(--p-dark),var(--p));border-radius:var(--radius-lg);padding:18px">' +
        '<div style="font-weight:700;font-size:15px;color:#fff;margin-bottom:3px">Quick Commands</div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,.75);margin-bottom:13px">Common triggers</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">' +
          [['📱','Print QR'],['💸','Issue Refund'],['📣','Promo Blast'],['🚫','Block Number']].map(arr =>
            '<button onclick="toast(\'' + arr[1] + ' triggered\',\'success\')" style="background:rgba(255,255,255,.18);border:none;border-radius:9px;padding:11px 8px;display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">' + arr[0] + '<span>' + arr[1] + '</span></button>'
          ).join('') +
        '</div>' +
        (canPos ? '<button class="btn full sm" style="margin-top:11px;background:rgba(255,255,255,.18);border:none;color:#fff;font-weight:700" onclick="navigate(\'pos\')">🧾 Open POS Terminal</button>' : '') +
      '</div>' +
    '</div>' +
  '</div>';

  const feed = root.querySelector('#live-feed');
  const recentOrders = orders.slice(0, 3);
  if (recentOrders.length === 0) {
    feed.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No recent activity</div></div>';
  }
  recentOrders.forEach(order => {
    const row = document.createElement('div'); row.className = 'feed-item';
    row.innerHTML = '<div class="feed-icon" style="background:#eff6ff">🍽</div>' +
      '<div class="feed-content"><div class="feed-top"><span class="feed-title">Room ' + escapeHtml(order.room_number) + ' — ' + escapeHtml(order.guest_name || 'Guest') + '</span>' + statusBadge(order.status) + '</div>' +
      '<div class="feed-sub">' + (order.items || []).map(i => i.qty + '× ' + i.name).join(', ') + ' — ' + formatMoney(order.total) + '</div></div>' +
      '<span class="feed-time">' + timeAgo(order.created_at) + '</span>';
    feed.appendChild(row);
  });

  const staffOnline = root.querySelector('#staff-online-list');
  const activeStaff = staffList.filter(s => s.status === 'active').slice(0, 4);
  if (activeStaff.length === 0) staffOnline.innerHTML = '<div style="font-size:13px;color:var(--text3)">No staff currently active</div>';
  activeStaff.forEach(s => {
    const initials = s.name.split(' ').map(n => n[0]).join('').slice(0, 2);
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px';
    row.innerHTML = '<div style="display:flex;align-items:center;gap:10px">' +
      '<div style="position:relative"><div style="width:36px;height:36px;border-radius:99px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:var(--p);border:2px solid var(--border)">' + initials + '</div>' +
      '<div style="position:absolute;bottom:0;right:0;width:10px;height:10px;border-radius:99px;background:var(--a);border:2px solid white"></div></div>' +
      '<div><div style="font-size:13px;font-weight:600;color:var(--text)">' + escapeHtml(s.name) + '</div><div style="font-size:11px;color:var(--text3)">' + escapeHtml(s.role) + '</div></div></div>' +
      '<button class="btn ghost sm" onclick="navigate(\'inbox\')">💬</button>';
    staffOnline.appendChild(row);
  });

  return root;
}
