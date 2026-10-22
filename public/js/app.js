// public/js/app.js
// Global App state + navigation + sidebar + shared modal actions + boot sequence.

window.App = {
  user: null,
  tenantId: null,
  tenant: null,
  permissions: [],
  accessToken: null,
  entitlements: null,
  page: 'dashboard',
  sidebarCollapsed: false,
};

// can(capability) — true if the current user's role/permission set grants it.
// superadmin always passes; other roles check the permissions array issued at login.
function can(capability) {
  if (!App.user) return false;
  if (App.user.role === 'superadmin') return true;
  return Array.isArray(App.permissions) && App.permissions.includes(capability);
}

const PAGE_TITLES = {
  dashboard: 'Dashboard', rooms: 'Room Management', inbox: 'WhatsApp Inbox', orders: 'Room Service Orders',
  pos: 'Point of Sale',  bookings: 'Bookings & Reservations', pool: 'Pool Bookings', halls: 'Hall & Event Bookings', gym: 'Gym & Fitness',
  tables: 'Tables & Seating',
  billing: 'Billing & Plan',
  wifi: 'Guest Wi-Fi', engine: 'Booking Engine',
  housekeeping: 'Housekeeping', maintenance: 'Maintenance', guests: 'Guest Profiles', analytics: 'Analytics & Reports',
  staff: 'Staff Directory', shifts: 'Shifts & Attendance', menu: 'Menu Manager', payments: 'Payments', settings: 'Settings',
  integrations: 'API Integrations',
  accounting: 'Accounting', eod: 'End of Day', misc: 'Other Services', ai: 'AI Setup & Configuration', printers: 'Printer Management',
  reports: 'Report Management',
  users: 'User Management & Permissions', superadmin: 'Super Admin',
};

function getNavItems() {
  if (!App.user) return [];
  const all = [
    { page: 'dashboard', ico: '⊞', label: 'Dashboard', cap: 'dashboard.view' },
    // Hidden from everyone except the hotel owner/admin (billing.manage);
    // superadmin manages billing per hotel inside the Super Admin console.
    { page: 'billing', ico: '💳', label: 'Billing & Plan', cap: 'billing.manage' },
    { page: 'rooms', ico: '🛏', label: 'Rooms', cap: 'rooms.manage' },
    { page: 'bookings', ico: '📅', label: 'Bookings', cap: 'bookings.manage' },
    { page: 'wifi', ico: '📶', label: 'Guest Wi-Fi', cap: 'bookings.manage' },
    { page: 'engine', ico: '🌐', label: 'Booking Engine', cap: 'bookings.manage' },
    { page: 'inbox', ico: '💬', label: 'WhatsApp Inbox', cap: 'inbox.use' },
    { page: 'orders', ico: '🍽', label: 'Room Service', cap: 'orders.manage' },
    // ── Restaurant & Bar — the F&B block lives under one sidebar section
    // header (items must stay contiguous: setupSidebar prints the header once
    // per run of sectioned items and a closing divider when it ends).
    { page: 'pos', ico: '🧾', label: 'Point of Sale', cap: 'pos.use', section: 'Restaurant & Bar' },
    { page: 'menu', ico: '📋', label: 'Menu Manager', cap: 'menu.manage', section: 'Restaurant & Bar' },
    { page: 'tables', ico: '🪑', label: 'Tables', cap: 'tables.use', section: 'Restaurant & Bar' },
    { page: 'pool', ico: '🏊', label: 'Pool Bookings', cap: 'pool.use' },
    { page: 'halls', ico: '🎪', label: 'Halls & Events', cap: 'halls.use' },
    { page: 'gym', ico: '🏋️', label: 'Gym & Fitness', cap: 'gym.use' },
    { page: 'misc', ico: '🧺', label: 'Other Services', cap: 'orders.manage' },
    { page: 'housekeeping', ico: '🧹', label: 'Housekeeping', cap: 'housekeeping.manage' },
    { page: 'maintenance', ico: '🔧', label: 'Maintenance', cap: 'maintenance.manage' },
    { page: 'guests', ico: '👤', label: 'Guests', cap: 'guests.manage' },
    { page: 'analytics', ico: '📊', label: 'Analytics', cap: 'analytics.view' },
    { page: 'reports', ico: '🗂️', label: 'Report Management', cap: 'analytics.view' },
    { page: 'staff', ico: '👥', label: 'Staff', cap: 'staff.manage' },
    { page: 'shifts', ico: '🕐', label: 'Shifts & Attendance', cap: 'attendance.use' },
    { page: 'eod', ico: '🌙', label: 'End of Day', cap: 'eod.use' },
    { page: 'payments', ico: '💳', label: 'Payments', cap: 'payments.use' },
    { page: 'accounting', ico: '📒', label: 'Accounting', cap: 'accounting.view' },
    { page: 'users', ico: '🔐', label: 'Users & Permissions', cap: 'users.manage' },
    { page: 'ai', ico: '🤖', label: 'AI Setup', cap: 'ai.manage' },
    { page: 'printers', ico: '🖨️', label: 'Printers', cap: 'printers.manage' },
    { page: 'integrations', ico: '🔌', label: 'API Integrations', cap: 'settings.manage' },
    { page: 'settings', ico: '⚙️', label: 'Settings', cap: 'settings.manage' },
  ];
  const visible = all.filter(x => !x.cap || can(x.cap));
  if (App.user.role === 'superadmin') visible.push({ page: 'superadmin', ico: '👑', label: 'Super Admin', section: 'Admin' });
  return visible;
}

function setupSidebar() {
  const u = App.user;
  document.getElementById('sb-user-av').textContent = u.avatar || u.name.slice(0, 2).toUpperCase();
  document.getElementById('sb-user-name').textContent = u.name;
  const roleLabels = { superadmin: 'Super Admin', hotel_admin: 'Hotel Admin', receptionist: 'Receptionist', staff: 'Staff', cashier: 'Cashier', barman: 'Barman' };
  document.getElementById('sb-user-role').textContent = App.tenant ? App.tenant.name : (u.role === 'superadmin' ? 'All Hotels' : (roleLabels[u.role] || u.role));

  const nav = document.getElementById('sb-nav');
  nav.innerHTML = '';
  let lastSection = '';
  getNavItems().forEach(item => {
    if ((item.section || '') !== lastSection) {
      if (item.section) {
        // Entering a group — print its header.
        const sep = document.createElement('div'); sep.className = 'sb-section'; sep.textContent = item.section; nav.appendChild(sep);
      } else if (lastSection) {
        // Leaving a group — close it visually so the flat items below don't
        // read as part of the section (e.g. Pool under "Restaurant & Bar").
        const end = document.createElement('div'); end.className = 'sb-section sb-divider'; nav.appendChild(end);
      }
      lastSection = item.section || '';
    }
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (App.page === item.page ? ' active' : '');
    btn.setAttribute('data-page', item.page);
    btn.onclick = () => navigate(item.page);
    btn.innerHTML = '<span class="ico">' + item.ico + '</span><span class="nav-label">' + item.label + '</span>';
    nav.appendChild(btn);
  });

  // Tenant branding: swap the default bubble for the hotel's uploaded logo.
  if (typeof window.__applyTenantLogo === 'function') window.__applyTenantLogo();

  // Superadmin: live count of Desk PC Edition registrations awaiting payment.
  refreshSelfhostBadge();
}

// ── Desk PC Edition: pending-orders badge on the Super Admin nav item ───────
// Fetched at boot, kept live by the selfhost.order_created WS event (the
// server pushes the fresh count) and re-fetched after confirmations.
function setSelfhostBadge(n) {
  const item = document.querySelector('.nav-item[data-page="superadmin"]');
  if (!item) return;
  let b = item.querySelector('.sh-badge');
  if (!n || n <= 0) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('span');
    b.className = 'badge sh-badge'; // .nav-item .badge styles it (margin-left:auto)
    item.appendChild(b);
  }
  b.textContent = n > 99 ? '99+' : String(n);
  b.title = n + ' Desk PC Edition registration' + (n === 1 ? '' : 's') + ' awaiting payment';
}

async function refreshSelfhostBadge() {
  if (!App.user || App.user.role !== 'superadmin') return;
  try {
    const r = await API.get('/api/selfhost/admin/pending-count');
    setSelfhostBadge(r && r.pending);
  } catch (e) { /* badge is a convenience — never block the shell */ }
}
window.refreshSelfhostBadge = refreshSelfhostBadge;

function toggleSidebar() {
  App.sidebarCollapsed = !App.sidebarCollapsed;
  const sb = document.getElementById('sidebar');
  const mw = document.getElementById('main-wrap');
  const btn = document.getElementById('sb-toggle-btn');
  sb.classList.toggle('collapsed', App.sidebarCollapsed);
  mw.style.marginLeft = App.sidebarCollapsed ? '64px' : 'var(--sidebar-w)';
  btn.textContent = App.sidebarCollapsed ? '▶' : '◀';
  document.querySelectorAll('.nav-label,.sb-user-info,.sb-brand,.sb-section').forEach(elx => { elx.style.display = App.sidebarCollapsed ? 'none' : ''; });
}
function openSidebar() { document.getElementById('sidebar').classList.add('mobile-open'); document.getElementById('sb-overlay').style.display = ''; }
function closeSidebar() { document.getElementById('sidebar').classList.remove('mobile-open'); document.getElementById('sb-overlay').style.display = 'none'; }

const PAGE_CAPS = {
  dashboard: 'dashboard.view', billing: 'billing.manage', rooms: 'rooms.manage', bookings: 'bookings.manage', inbox: 'inbox.use',
  orders: 'orders.manage', pos: 'pos.use', pool: 'pool.use', halls: 'halls.use', gym: 'gym.use', misc: 'orders.manage',
  tables: 'tables.use',
  housekeeping: 'housekeeping.manage', maintenance: 'maintenance.manage', guests: 'guests.manage',
  analytics: 'analytics.view', reports: 'analytics.view', staff: 'staff.manage', shifts: 'attendance.use', eod: 'eod.use', menu: 'menu.manage',
  payments: 'payments.use', accounting: 'accounting.view', ai: 'ai.manage', printers: 'printers.manage',
  users: 'users.manage', settings: 'settings.manage',
};

function navigate(page) {
  if (PAGE_CAPS[page] && !can(PAGE_CAPS[page])) {
    toast('You don\'t have permission to access that module', 'error');
    return;
  }
  if (page === 'billing' && App.user && App.user.role === 'superadmin' && !App.tenantId) {
    toast('Billing is managed per hotel — pick one in Super Admin first', 'info');
    page = 'superadmin';
  }
  if (PAGE_CAPS[page] && App.user && App.user.role === 'superadmin' && !App.tenantId) {
    toast('Pick a hotel to manage first', 'info');
    page = 'superadmin';
  }
  App.page = page;
  closeSidebar();
  document.getElementById('topbar-title').textContent = PAGE_TITLES[page] || page;
  document.querySelectorAll('.nav-item').forEach(elx => elx.classList.toggle('active', elx.dataset.page === page));
  const c = document.getElementById('content');
  c.innerHTML = '';
  const fn = window.PAGES && window.PAGES[page];
  if (fn) c.appendChild(fn());
  else c.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🚧</div><div class="empty-state-title">Page not found</div></div>';
  window.scrollTo(0, 0);
}

// Real cross-module search: queries bookings, guests, rooms, transactions,
// menu items and staff in one round-trip and jumps straight to the module
// whose record was picked from the results.
const SEARCH_ENDPOINTS = [
  { module: 'bookings', label: 'Booking', get: q => API.get('/api/bookings').then(bs => bs.filter(b => (b.reference || '').toLowerCase().includes(q) || (b.guest_name || '').toLowerCase().includes(q)).slice(0, 5).map(b => ({ id: b.id, title: (b.reference || b.id) + ' — ' + (b.guest_name || 'Guest'), go: () => navigate('bookings') }))) },
  { module: 'guests', label: 'Guest', get: q => API.get('/api/guests').then(gs => gs.filter(g => (g.full_name || g.name || '').toLowerCase().includes(q) || (g.phone || '').includes(q)).slice(0, 5).map(g => ({ id: g.id, title: (g.full_name || g.name) + (g.phone ? ' · ' + g.phone : ''), go: () => navigate('guests') }))) },
  { module: 'rooms', label: 'Room', get: q => API.get('/api/rooms').then(rs => rs.filter(r => ('' + (r.number || '')).toLowerCase().includes(q)).slice(0, 5).map(r => ({ id: r.id, title: 'Room ' + r.number + ' (' + r.status + ')', go: () => navigate('rooms') }))) },
  { module: 'payments', label: 'Transaction', get: q => API.get('/api/payments/transactions').then(ts => ts.filter(t => (t.guest_name || '').toLowerCase().includes(q) || (t.gateway_ref || '').toLowerCase().includes(q)).slice(0, 5).map(t => ({ id: t.id, title: (t.guest_name || 'Txn') + ' · ' + (t.amount || 0), go: () => navigate('payments') }))) },
];
let __searchResults = [];
function globalSearch(q) {
  const box = document.getElementById('searchResults');
  if (!q || q.length < 2) { if (box) { box.style.display = 'none'; box.innerHTML = ''; } return; }
  const needle = q.toLowerCase().trim();
  Promise.allSettled(SEARCH_ENDPOINTS.map(e => e.get(needle)))
    .then(results => {
      __searchResults = [];
      const labels = SEARCH_ENDPOINTS.map(e => e.label);
      results.forEach((r, i) => { if (r.status === 'fulfilled' && Array.isArray(r.value)) r.value.forEach(item => __searchResults.push({ ...item, label: labels[i] })); });
      if (!box) return;
      if (!__searchResults.length) {
        box.innerHTML = '<div class="search-empty">No matches for "' + escapeHtml(q) + '"</div>';
        box.style.display = 'block';
        return;
      }
      box.innerHTML = __searchResults.map((s, idx) =>
        '<button class="search-row" data-idx="' + idx + '"><b>' + (s.label || 'Item') + '</b> ' + escapeHtml(s.title || '') + '</button>').join('');
      box.style.display = 'block';
      box.querySelectorAll('.search-row').forEach(btn => {
        btn.onclick = () => {
          const s = __searchResults[+btn.dataset.idx];
          box.style.display = 'none';
          if (s && s.go) s.go();
        };
      });
    });
}
function showNotifications() { toast('You have no new notifications', 'info'); }
// User menu: a real dropdown (not a toast) — shows the signed-in identity and
// quick actions, including the personal skin-theme picker.
function openUserMenu() {
  const old = document.getElementById('user-menu');
  if (old) { old.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'user-menu';
  menu.style.cssText = 'position:fixed;top:64px;right:12px;z-index:100;background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-lg);min-width:230px;overflow:hidden';
  menu.innerHTML =
    '<div style="padding:14px 16px;border-bottom:1px solid var(--border)">' +
      '<div style="font-weight:700;font-size:14px">' + escapeHtml(App.user.name || '') + '</div>' +
      '<div style="font-size:12px;color:var(--text3)">' + escapeHtml(App.user.email || '') + '</div></div>' +
    '<button class="user-menu-item" onclick="window.__openThemePicker()">🎨 Choose your theme</button>' +
    '<button class="user-menu-item" onclick="window.__openChangePassword()">🔒 Change password</button>' +
    '<button class="user-menu-item" onclick="window.__doLogout && window.__doLogout()">⎋ Sign out</button>';
  document.body.appendChild(menu);
  const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ── Change password (self-service) ─────────────────────────────────────────
// The server endpoint POST /api/auth/change-password (requireAuth only) has
// always existed — but nothing in the app ever called it, so no signed-in user
// could change their own password. This gives it a UI. It works for the
// platform superadmin too: the identity comes from the session token, not from
// the tenant's user list. On success the server revokes the user's refresh
// tokens, so we sign out deliberately instead of letting the next refresh fail.
window.__openChangePassword = function () {
  openModal('Change Password',
    '<div class="form-group"><label class="form-label">Current password</label>' +
      '<input class="form-input" type="password" id="cp-current" autocomplete="current-password"></div>' +
    '<div class="form-group"><label class="form-label">New password</label>' +
      '<input class="form-input" type="password" id="cp-new" autocomplete="new-password"></div>' +
    '<div class="form-group"><label class="form-label">Repeat new password</label>' +
      '<input class="form-input" type="password" id="cp-confirm" autocomplete="new-password"></div>' +
    '<p style="font-size:11.5px;color:var(--text3)">8+ characters with an uppercase letter, a lowercase letter, a number and a symbol. You will be signed out once to apply the change — everywhere.</p>',
    '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
    '<button class="btn primary" id="cp-save">Update password</button>');
  document.getElementById('cp-save').onclick = async () => {
    const cur = document.getElementById('cp-current').value;
    const next = document.getElementById('cp-new').value;
    const again = document.getElementById('cp-confirm').value;
    const btn = document.getElementById('cp-save');
    const strong = p => p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);
    if (!cur) return toast('Enter your current password.', 'warn');
    if (!strong(next)) return toast('New password needs 8+ characters with an uppercase letter, a lowercase letter, a number and a symbol.', 'warn');
    if (next !== again) return toast('The two new passwords do not match.', 'warn');
    btn.disabled = true; btn.textContent = 'Updating…';
    try {
      await API.post('/api/auth/change-password', { currentPassword: cur, newPassword: next });
      closeModal();
      toast('Password changed. Signing you out to apply it — log back in with your new password.', 'success', 4000);
      setTimeout(() => (window.__doLogout ? window.__doLogout() : (location.href = '/app')), 1500);
    } catch (err) {
      toast(err.message || 'Could not change the password.', 'error');
      btn.disabled = false; btn.textContent = 'Update password';
    }
  };
};

// ── SaaS: plan banner ───────────────────────────────────────────────────
// The plan/trial state stays visible to the whole team (transparency), but the
// "View plan" action — and the Billing & Plan page itself — is owner/admin
// only (billing.manage; enforced server-side on /api/billing/*).
function showTrialBanner() {
  const ent = App.entitlements;
  if (!ent) return;
  const old = document.getElementById('trial-banner');
  if (old) old.remove();

  let text = null;
  if (ent.status === 'trial' && ent.trial) {
    const days = ent.trial.daysLeft;
    text = (days <= 3 ? '⏰' : '🎁') + ' Trial: ' + days + ' day' + (days === 1 ? '' : 's') + ' left on the ' + ent.planName + ' plan' +
      (ent.pendingApproval ? ' · plan activation pending approval' : '');
  } else if (ent.status === 'active') {
    text = '💳 ' + ent.planName + ' plan';
  } else if (ent.status === 'suspended') {
    text = '⚠️ Subscription suspended — some features are locked';
  }
  if (!text) return;

  const div = document.createElement('div');
  div.id = 'trial-banner';
  div.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 14px;font-size:12.5px;font-weight:600;background:linear-gradient(90deg,rgba(79,140,255,.15),rgba(34,211,167,.12));border-bottom:1px solid var(--border);color:var(--text)';
  const canManage = can('billing.manage');
  div.innerHTML = '<span>' + text + '</span>' +
    (canManage
      ? '<button class="btn primary" style="padding:4px 12px;font-size:11.5px" onclick="openBillingPage()">View plan</button>'
      : '');
  const mainWrap = document.getElementById('main-wrap');
  mainWrap.insertBefore(div, mainWrap.firstChild);
}

function openBillingPage() {
  if (App.user && App.user.role === 'superadmin' && !App.tenantId) { toast('Billing is managed per hotel — pick one in Super Admin first', 'info'); return; }
  navigate('billing');
}

// ── SaaS: 402 upgrade modal — opened by api.js on UPGRADE_REQUIRED ─────────
window.openUpgradeModal = async function (payload) {
  let plans = [];
  try { plans = (await API.get('/api/billing/pricing')).plans; } catch (e) { plans = []; }
  const current = (payload && payload.currentPlan) || (App.entitlements && App.entitlements.planId) || 'starter';
  const message = (payload && payload.error) || 'This feature is not part of your current plan.';
  openModal('Upgrade Plan',
    '<div class="alert error" style="margin-bottom:16px">' + message + '</div>' +
    '<div style="display:grid;gap:12px">' + plans.map(p =>
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:1px solid ' + (p.id === current ? 'var(--primary)' : 'var(--border)') + ';border-radius:12px">' +
        '<div><b>' + p.name + '</b> <span style="color:var(--text3);font-size:12px">— ' + p.featureLabels.slice(0, 3).join(' · ') + '…</span></div>' +
        '<div style="text-align:right;white-space:nowrap"><b>$' + p.priceMonthly + '</b><span style="font-size:11px;color:var(--text3)">/mo</span><br>' +
        '<button class="btn primary" style="padding:4px 12px;font-size:11.5px;margin-top:4px" onclick="requestPlanFromModal(\'' + p.id + '\')">' + (p.id === current ? 'Current' : 'Choose') + '</button></div>' +
      '</div>').join('') + '</div>',
    '<button class="btn outline" onclick="closeModal()">Close</button>'
  );
};

window.requestPlanFromModal = async function (planId) {
  try {
    const r = await API.post('/api/billing/request-plan', { planId, billingCycle: 'monthly' });
    // Platform payments automated: the gateway's hosted checkout activates the
    // plan via webhook — send the hotel straight there.
    if (r.checkoutUrl) {
      closeModal();
      toast('Redirecting to secure checkout…', 'success', 4000);
      setTimeout(() => { window.location.href = r.checkoutUrl; }, 800);
      return;
    }
    // Keep the Billing page module in sync (it re-loads itself if visible).
    if (typeof requestPlanFromModalShared === 'function' && App.page === 'billing') { /* already handled by page load */ }
    closeModal();
    openModal('Complete Activation',
      '<div class="alert success" style="margin-bottom:14px">Request recorded. Pay <b>$' + r.amount + '/mo</b> and give the reference below to the platform team (or use it on the transfer receipt).</div>' +
      '<div style="text-align:center;background:var(--surface2);border-radius:12px;padding:18px;margin-bottom:12px"><div style="font-size:11px;color:var(--text3);letter-spacing:1px">PAYMENT REFERENCE</div>' +
      '<div style="font-size:26px;font-weight:800;letter-spacing:2px;margin:6px 0">' + r.paymentReference + '</div></div>' +
      '<p style="font-size:12.5px;color:var(--text3)">Your plan activates the moment payment is confirmed — usually within one business day.</p>',
      '<button class="btn primary" onclick="closeModal(); navigate(\'billing\')">Open Billing</button>');
    if (typeof loadBilling === 'function') loadBilling();
  } catch (e) { toast(e.message, 'error'); }
};

// ── Shared cross-page modal actions ─────────────────────────────────────────
window.openNewIncident = function () {
  openModal('New Incident',
    '<div class="form-row cols-2" style="margin-bottom:14px">' +
      '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="inc-type"><option>Housekeeping</option><option>Maintenance</option><option>Guest Complaint</option><option>Security</option><option>Other</option></select></div>' +
      '<div class="form-group"><label class="form-label">Room</label><input class="form-input" id="inc-room" placeholder="e.g. 204"/></div></div>' +
    '<div class="form-group"><label class="form-label">Description</label><textarea class="form-textarea" id="inc-desc" placeholder="Describe the incident…"></textarea></div>',
    '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger" onclick="window.__submitIncident()">Submit Incident</button>'
  );
  window.__submitIncident = async function () {
    const room = document.getElementById('inc-room').value.trim();
    const issue = document.getElementById('inc-desc').value.trim();
    if (!issue) { toast('Description required', 'error'); return; }
    try {
      // Incidents route through the maintenance API for now (unified ops queue)
      await API.post('/api/maintenance', { roomNumber: room || 'N/A', issue: '[' + document.getElementById('inc-type').value + '] ' + issue, priority: 'high' });
      toast('Incident logged and staff notified', 'success');
      closeModal();
      if (App.page === 'maintenance') navigate('maintenance');
    } catch (err) { toast(err.message, 'error'); }
  };
};

window.openBroadcast = function () {
  openModal('Broadcast Message',
    '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Target Audience</label><select class="form-select" id="bc-target"><option value="all">All Guests (Currently Checked In)</option><option>Checked-out Today</option><option>Gold+ Loyalty Members</option></select></div>' +
    '<div class="form-group"><label class="form-label">Message</label><textarea class="form-textarea" id="bc-msg" placeholder="Type your WhatsApp broadcast message here…" style="min-height:120px"></textarea></div>' +
    '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;font-size:12px;color:var(--text3);margin-top:10px">In production this sends via the WhatsApp Business API to every matching guest\'s conversation.</div>',
    '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn accent" onclick="window.__sendBroadcast()">Send Broadcast</button>'
  );
  window.__sendBroadcast = function () {
    const msg = document.getElementById('bc-msg').value.trim();
    if (!msg) { toast('Message required', 'error'); return; }
    toast('Broadcast sent (demo — connect WhatsApp in Settings to send for real)', 'success');
    closeModal();
  };
};

// ── Boot sequence ──────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.ctrlKey && e.key === 'k') { const s = document.getElementById('global-search'); if (s) { e.preventDefault(); s.focus(); } }
});

function registerRealtimeHandlers() {
  // Page modules also attach their own WSClient.on(...) listeners when constructed.
  WSClient.on('connected', () => { refreshSelfhostBadge(); }); // re-sync counts after (re)connect

  // A landing-page registration flips the Super Admin badge live (and only
  // superadmins ever see the badge — other roles ignore the event).
  WSClient.on('selfhost.order_created', (p) => {
    if (!App.user || App.user.role !== 'superadmin') return;
    if (p && typeof p.count === 'number') setSelfhostBadge(p.count);
    else refreshSelfhostBadge();
    toast('🖥️ New Desk PC Edition registration — ' + (p && typeof p.count === 'number' ? p.count + ' awaiting payment' : 'check Billing & Approvals'), 'info', 8000);
  });

  // Platform subscription events — global toasts so hotel admins learn about
  // billing state changes wherever they are in the app (the Billing page
  // re-renders itself via its own listeners when open).
  WSClient.on('renewal.reminder', (p) => {
    toast('🔔 Your ' + (p.planId || '') + ' plan renews in ' + p.daysLeft + ' day' + (p.daysLeft === 1 ? '' : 's') + ' — open Billing & Plan to renew.', 'warn', 9000);
  });
  WSClient.on('subscription.expired', () => {
    toast('Your subscription expired — premium modules are locked. Renew from Billing & Plan.', 'error', 12000);
  });
  WSClient.on('subscription.activated', (p) => {
    toast('🎉 Payment confirmed — you are now on the ' + (p.planName || p.planId || '') + ' plan!', 'success', 8000);
  });
}

window.addEventListener('DOMContentLoaded', () => {
  tryRestoreSession();
  startStaleUiDetector();
});

// ═══════════════════════════════════════════════════════════════════════════
// STALE-UI DETECTOR
// The SPA loads page modules once when the browser first fetched them; a
// deploy that swaps the code on the server does NOT reload code inside a
// session that never navigates away (an owner's desktop tab can stay open
// for days). The detector records what the server SERVED at session start
// (UI build stamp + boot id via /api/version) and quietly re-checks every
// few minutes while the tab is open; on a mismatch it tells the user to
// reload — with a one-click reload action so updates apply instantly.
// ═══════════════════════════════════════════════════════════════════════════
let __staleUiState = { served: null, checked: 0, warned: false };

async function startStaleUiDetector() {
  try {
    const v = await API.get('/api/version');
    __staleUiState.served = v.uiBuildStamp;
    window.__serverBootId = v.bootId;
    window.__serverUiStamp = v.uiBuildStamp;
  } catch (e) { return; } // pointless without the endpoint; silent

  // Re-check every 3 minutes; also re-check when the tab regains visibility
  // (deploy happened while the desk was away — they should see it by their
  // NEXT interaction, not later into a shift).
  setInterval(checkStaleUi, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkStaleUi();
  });
}

async function checkStaleUi() {
  __staleUiState.checked++;
  let v;
  try { v = await API.get('/api/version'); }
  catch (e) { return; } // offline / server restarting — nothing to conclude
  if (!v || !v.uiBuildStamp) return;

  window.__serverBootId = v.bootId;
  window.__serverUiStamp = v.uiBuildStamp;
  // Filter out double-fire (visibility + timer in same moment)
  if (__staleUiState.warned) return;

  const fresh = v.uiBuildStamp !== __staleUiState.served;
  const restarted = __staleUiState.served && v.bootId !== window.__serverBootId && fresh;
  if (fresh || restarted) {
    __staleUiState.warned = true;
    const msg = '🆕 A new version of StayChat OS just went live. Your open page is still running the old UI — reload to get the latest fixes.';
    toast(msg, 'info', 12000);
    console.warn('[stale-ui]', 'served=' + __staleUiState.served, 'now=' + v.uiBuildStamp, restarted ? '(server restarted)' : '');
    if (typeof openModal === 'function') {
      openModal('New version available',
        '<p style="font-size:14px;color:var(--text2);line-height:1.55">A new version of StayChat OS just went live. Your open page is still running the old interface — <b>reload now</b> to pick up the latest fixes and features.</p>' +
        '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;font-size:12px;color:var(--text3);margin-top:10px">Reload is safe: unsaved form data on ServeDesk pages is not stored anywhere else, and any half-typed registration is preserved by the draft system.</div>',
        '<button class="btn outline" onclick="closeModal()">Later</button><button class="btn primary" onclick="window.location.reload()">Reload Now</button>'
      );
    }
  }
}
