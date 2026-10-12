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
          [['📱','Print QR','openPrintQr'],['💸','Issue Refund','openRefund'],['📣','Promo Blast','openPromoBlast'],['🚫','Block Number','openBlockNumber']].map(arr =>
            '<button onclick="' + arr[2] + '()" style="background:rgba(255,255,255,.18);border:none;border-radius:9px;padding:11px 8px;display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;color:#fff;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">' + arr[0] + '<span>' + arr[1] + '</span></button>'
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

// ══════════════════════════════════════════════════════════════════════════
// Quick Commands — the four buttons on the dashboard's right rail. Each opens
// a REAL modal wired to a REAL API. This block used to be four fake toasts.
// ══════════════════════════════════════════════════════════════════════════

// ── Print QR: a genuinely printable QR poster for the hotel's booking page ──
// Reuses the server's local QR generator (same endpoint printed on guest
// confirmation slips) so the QR never leaves our infrastructure.
window.openPrintQr = async function () {
  if (!App.tenant || !App.tenant.subdomain) { toast('Sign in to a hotel first', 'error'); return; }
  const origin = window.location.origin;
  const bookUrl = origin + '/book.html?hotel=' + encodeURIComponent(App.tenant.subdomain) + '&v=2';
  const qrUrl = '/api/booking-engine/qr?hotel=' + encodeURIComponent(App.tenant.subdomain) + '&code=';
  openModal('📱 Print Booking QR',
    '<div style="text-align:center">' +
      '<div style="background:#fff;display:inline-block;padding:14px;border-radius:12px;border:1px solid var(--border)"><img id="qr-poster-img" alt="Booking QR" src="' + qrUrl + '" style="width:230px;height:230px;display:block"></div>' +
      '<div style="font-weight:800;font-size:15px;margin-top:12px;color:var(--text)">' + escapeHtml((App.tenant && App.tenant.name) || 'Book Online') + '</div>' +
      '<div style="font-size:12.5px;color:var(--text2);margin-top:3px">Scan to book your stay — confirm instantly at the front desk</div>' +
      '<div style="font-size:11px;font-family:var(--font-mono);color:var(--text3);margin-top:8px;word-break:break-all">' + escapeHtml(bookUrl) + '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:14px"><label class="form-label">Also include (optional)</label>' +
      '<input class="form-input" id="qr-subline" placeholder="e.g. Book code BE-… and show this at reception"/></div>',
    '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__printQrPoster()">🖨️ Print Poster</button>'
  );
  window.__printQrPoster = () => {
    const subline = document.getElementById('qr-subline').value.trim();
    const sub = App.tenant.subdomain;
    const win = window.open('', '_blank', 'width=520,height=760');
    if (!win) { toast('Popup blocked — allow popups to print', 'error'); return; }
    win.document.write('<html><head><title>Booking QR</title><style>' +
      '@page { margin: 14mm; } body { font-family: Arial, sans-serif; color: #000; text-align: center; padding: 24px; }' +
      'img { width: 320px; height: 320px; } h1 { font-size: 22px; margin: 18px 0 4px; }' +
      '.sub { color: #333; font-size: 16px; margin-bottom: 6px; } .url { font-family: monospace; font-size: 12px; color: #555; word-break: break-all; margin-top: 14px; }</style></head><body>' +
      '<div style="font-size:32px">📱</div>' +
      '<img src="' + qrUrl + '" alt="QR">' +
      '<h1>' + escapeHtml((App.tenant && App.tenant.name) || 'Book Online') + '</h1>' +
      '<div class="sub">Scan to book your stay' + (subline ? ' — ' + escapeHtml(subline) : '') + '</div>' +
      '<div class="url">' + escapeHtml(bookUrl) + '</div>' +
    '</body></html>');
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
  };
};

// ── Issue Refund: pick a completed payment, write a reason, refund it. ──────
// Guarded server-side by payments.manage; the desk sees exactly that error
// text if someone without the permission tries.
window.openRefund = async function () {
  let txns;
  try { txns = await API.get('/api/payments/transactions'); } catch (err) { toast(err.message, 'error'); return; }
  const refundable = txns.filter(t => t.status === 'completed');
  const rows = refundable.slice(0, 40).map(t =>
    '<div class="rf-row" data-id="' + escapeHtml(t.id) + '" style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);cursor:pointer;margin-bottom:8px">' +
      '<div style="width:14px;height:14px;border-radius:99px;border:2px solid var(--border)"></div>' +
      '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(t.guest_name || 'Guest') + (t.room_number ? ' · Room ' + escapeHtml(t.room_number) : '') + '</div>' +
      '<div style="font-size:11px;color:var(--text3)">' + escapeHtml(t.description || t.method) + ' · ' + timeAgo(t.created_at) + '</div></div>' +
      '<div style="font-weight:800;color:var(--a)">' + formatMoney(t.amount) + '</div>' +
    '</div>').join('');
  openModal('💸 Issue Refund',
    (refundable.length === 0
      ? '<div style="font-size:13px;color:var(--text3);padding:12px 0">No completed payments to refund yet.</div>'
      : '<div style="margin-bottom:14px"><div class="form-label" style="margin-bottom:8px">Pick the completed payment to refund</div>' + rows + '</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Refund Amount</label><input class="form-input" type="number" step="0.01" min="0.01" id="rf-amount" placeholder="Full amount"/></div>' +
          '<div class="form-group"><label class="form-label">Written reason (required)</label><input class="form-input" id="rf-reason" placeholder="e.g. Duplicate charge, guest dispute"/></div>' +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-top:6px"><input type="checkbox" id="rf-reopen"/> Re-open the booking if it was checked out over this payment</label>' +
        '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;font-size:11.5px;color:var(--text3);margin-top:12px">Refunds are ledger-real: the transaction flips to <b>refunded</b>, a reversing journal entry posts, and the money leaves via your cash drawer or gateway account. Owner/manager only.</div>'),
    '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger" ' + (refundable.length ? '' : 'disabled') + ' onclick="window.__confirmRefund()">Refund Payment</button>'
  );
  window.__rfId = null;
  document.querySelectorAll('#modal .rf-row').forEach(row => {
    row.onclick = () => {
      document.querySelectorAll('#modal .rf-row').forEach(r => { r.style.background = ''; r.firstElementChild.style.borderColor = ''; });
      row.style.background = 'var(--surface2)'; row.firstElementChild.style.borderColor = 'var(--a)';
      window.__rfId = row.dataset.id;
      const t = refundable.find(x => x.id === row.dataset.id);
      if (t) document.getElementById('rf-amount').value = t.amount;
    };
  });
  window.__confirmRefund = async () => {
    if (!window.__rfId) { toast('Pick a payment to refund first', 'error'); return; }
    const reason = document.getElementById('rf-reason').value.trim();
    if (!reason) { toast('A written reason is required', 'error'); return; }
    const amountRaw = document.getElementById('rf-amount').value;
    try {
      const r = await API.post('/api/payments/refund', {
        transactionId: window.__rfId,
        amount: amountRaw === '' ? undefined : Number(amountRaw),
        reason,
        reopenBooking: document.getElementById('rf-reopen').checked,
      });
      closeModal();
      toast('Refund of ' + formatMoney(r.refunded) + ' recorded' + (r.reopened ? ' — booking re-opened' : ''), 'success');
    } catch (err) { toast(err.message, 'error'); }
  };
};

// ── Promo Blast: preview who receives it, then send via WhatsApp. ──────────
window.__promoAudience = 'all';
window.openPromoBlast = async function () {
  let preview;
  try { preview = await API.get('/api/messaging/promo/preview?audience=all'); } catch (err) { toast(err.message, 'error'); return; }
  openModal('📣 Promo Blast',
    '<div class="form-group" style="margin-bottom:10px"><label class="form-label">Audience</label>' +
      '<select class="form-select" id="promo-audience" onchange="window.__promoPreview()">' +
        '<option value="all">All recent &amp; active guests</option>' +
        '<option value="checked_in">Checked-in guests (staying now)</option>' +
        '<option value="upcoming">Confirmed arrivals (next 14 days)</option>' +
        '<option value="past">Past guests (last 90 days)</option>' +
      '</select></div>' +
    '<div id="promo-preview" style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;font-size:12.5px;margin-bottom:12px">' + renderPreview(preview) + '</div>' +
    '<div class="form-group"><label class="form-label">Message (WhatsApp)</label>' +
      '<textarea class="form-textarea" id="promo-msg" style="min-height:110px" placeholder="Hi {name}! Weekend special: 20% off all suites…"></textarea></div>' +
    '<div style="font-size:11.5px;color:var(--text3);margin-top:8px">{name} is replaced with each guest\'s first name. Blocked numbers are always excluded.</div>',
    '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__sendPromoBlast()">📣 Send Blast</button>'
  );
  function renderPreview(p) {
    return '<b>' + p.recipients + '</b> guest' + (p.recipients === 1 ? '' : 's') + ' will receive this' +
      (p.blockedExcluded ? ' · ' + p.blockedExcluded + ' blocked number' + (p.blockedExcluded === 1 ? '' : 's') + ' excluded' : '') +
      (!p.whatsappConfigured ? ' · <span style="color:var(--warn)">⚠ WhatsApp not connected — sends will be skipped (connect it in API Integrations)</span>' : '') +
      (p.sample && p.sample.length ? '<div style="margin-top:6px;color:var(--text3)">e.g. ' + p.sample.map(s => escapeHtml((s.name || '') + ' · ' + s.phone)).slice(0, 3).join(', ') + '</div>' : '');
  }
  window.__promoPreview = async () => {
    const a = document.getElementById('promo-audience').value;
    try {
      const p = await API.get('/api/messaging/promo/preview?audience=' + a);
      document.getElementById('promo-preview').innerHTML = renderPreview(p);
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__sendPromoBlast = async () => {
    const audience = document.getElementById('promo-audience').value;
    const message = document.getElementById('promo-msg').value.trim();
    if (!message) { toast('Message is required', 'error'); return; }
    const btn = document.querySelector('#modal .modal-footer .btn.primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const r = await API.post('/api/messaging/promo-blast', { audience, message });
      closeModal();
      toast('Blast complete — ' + r.sent + ' sent' + (r.skipped ? ', ' + r.skipped + ' skipped (WhatsApp not connected)' : '') + (r.failed ? ', ' + r.failed + ' failed' : ''), r.failed ? 'warn' : 'success', 8000);
    } catch (err) { toast(err.message, 'error'); if (btn) { btn.disabled = false; btn.textContent = '📣 Send Blast'; } }
  };
};

// ── Block Number: CRUD over the per-tenant phone blocklist. ───────────────
window.openBlockNumber = async function () {
  let list;
  try { list = await API.get('/api/blocklist'); } catch (err) { toast(err.message, 'error'); return; }
  const canManage = can('guests.manage');
  openModal('🚫 Blocked Numbers',
    '<div style="display:flex;gap:8px;margin-bottom:14px">' +
      '<input class="form-input" id="bl-phone" placeholder="Phone number e.g. +2348012345678" style="flex:1" ' + (canManage ? '' : 'disabled') + '/>' +
      '<input class="form-input" id="bl-reason" placeholder="Reason (optional)" ' + (canManage ? '' : 'disabled') + '/>' +
      '<button class="btn danger" ' + (canManage ? '' : 'disabled') + ' onclick="window.__blockAdd()">Block</button>' +
    '</div>' +
    '<div id="bl-list" style="max-height:320px;overflow:auto">' +
      (list.length === 0
        ? '<div style="font-size:13px;color:var(--text3);padding:10px 0">No numbers blocked. Blocked phones cannot book rooms, halls or pool slots online.</div>'
        : list.map(b =>
          '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px">' +
            '<div style="flex:1"><div style="font-weight:700;font-size:13px">' + escapeHtml(b.phoneOriginal) + '</div>' +
            '<div style="font-size:11px;color:var(--text3)">' + (b.reason ? escapeHtml(b.reason) + ' · ' : '') + 'blocked ' + timeAgo(b.createdAt) + (b.blockedBy ? ' by ' + escapeHtml(b.blockedBy) : '') + '</div></div>' +
            (canManage ? '<button class="btn ghost sm" onclick="window.__blockRemove(\'' + b.id + '\')">Unblock</button>' : '') +
          '</div>').join('')) +
    '</div>' +
    '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;font-size:11.5px;color:var(--text3);margin-top:12px">Enforcement is automatic: every online booking submission (room, hall or pool) from a blocked phone is refused.</div>',
    '<button class="btn outline" onclick="closeModal()">Done</button>'
  );
  window.__blockAdd = async () => {
    const phone = document.getElementById('bl-phone').value.trim();
    if (!phone) { toast('Phone number is required', 'error'); return; }
    try {
      await API.post('/api/blocklist', { phone, reason: document.getElementById('bl-reason').value.trim() });
      toast('Number blocked', 'success');
      closeModal(); openBlockNumber();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__blockRemove = async (id) => {
    try {
      await API.del('/api/blocklist/' + id);
      toast('Number unblocked', 'success');
      closeModal(); openBlockNumber();
    } catch (err) { toast(err.message, 'error'); }
  };
};
