// public/js/app.js
// Global App state + navigation + sidebar + shared modal actions + boot sequence.

window.App = {
  user: null,
  tenantId: null,
  tenant: null,
  permissions: [],
  accessToken: null,
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
  pos: 'Point of Sale',  bookings: 'Bookings & Reservations', pool: 'Pool Bookings', halls: 'Hall & Event Bookings',
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
    { page: 'rooms', ico: '🛏', label: 'Rooms', cap: 'rooms.manage' },
    { page: 'bookings', ico: '📅', label: 'Bookings', cap: 'bookings.manage' },
    { page: 'wifi', ico: '📶', label: 'Guest Wi-Fi', cap: 'bookings.manage' },
    { page: 'engine', ico: '🌐', label: 'Booking Engine', cap: 'bookings.manage' },
    { page: 'inbox', ico: '💬', label: 'WhatsApp Inbox', cap: 'inbox.use' },
    { page: 'orders', ico: '🍽', label: 'Room Service', cap: 'orders.manage' },
    { page: 'pos', ico: '🧾', label: 'Point of Sale', cap: 'pos.use' },
    { page: 'pool', ico: '🏊', label: 'Pool Bookings', cap: 'pool.use' },
    { page: 'halls', ico: '🎪', label: 'Halls & Events', cap: 'halls.use' },
    { page: 'misc', ico: '🧺', label: 'Other Services', cap: 'orders.manage' },
    { page: 'housekeeping', ico: '🧹', label: 'Housekeeping', cap: 'housekeeping.manage' },
    { page: 'maintenance', ico: '🔧', label: 'Maintenance', cap: 'maintenance.manage' },
    { page: 'guests', ico: '👤', label: 'Guests', cap: 'guests.manage' },
    { page: 'analytics', ico: '📊', label: 'Analytics', cap: 'analytics.view' },
    { page: 'reports', ico: '🗂️', label: 'Report Management', cap: 'analytics.view' },
    { page: 'staff', ico: '👥', label: 'Staff', cap: 'staff.manage' },
    { page: 'shifts', ico: '🕐', label: 'Shifts & Attendance', cap: 'attendance.use' },
    { page: 'eod', ico: '🌙', label: 'End of Day', cap: 'eod.use' },
    { page: 'menu', ico: '📋', label: 'Menu Manager', cap: 'menu.manage' },
    { page: 'payments', ico: '💳', label: 'Payments', cap: 'payments.use' },
    { page: 'accounting', ico: '📒', label: 'Accounting', cap: 'accounting.view' },
    { page: 'users', ico: '🔐', label: 'Users & Permissions', cap: 'users.manage' },
    { page: 'ai', ico: '🤖', label: 'AI Setup', cap: 'ai.manage' },
    { page: 'printers', ico: '🖨️', label: 'Printers', cap: 'printers.manage' },
    { page: 'integrations', ico: '🔌', label: 'API Integrations', cap: 'settings.manage' },
    { page: 'settings', ico: '⚙️', label: 'Settings', cap: 'settings.manage' },
  ];
  const visible = all.filter(x => can(x.cap));
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
    if (item.section && item.section !== lastSection) {
      const sep = document.createElement('div'); sep.className = 'sb-section'; sep.textContent = item.section; nav.appendChild(sep); lastSection = item.section;
    }
    const btn = document.createElement('button');
    btn.className = 'nav-item' + (App.page === item.page ? ' active' : '');
    btn.setAttribute('data-page', item.page);
    btn.onclick = () => navigate(item.page);
    btn.innerHTML = '<span class="ico">' + item.ico + '</span><span class="nav-label">' + item.label + '</span>';
    nav.appendChild(btn);
  });
}

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
  dashboard: 'dashboard.view', rooms: 'rooms.manage', bookings: 'bookings.manage', inbox: 'inbox.use',
  orders: 'orders.manage', pos: 'pos.use', pool: 'pool.use', halls: 'halls.use', misc: 'orders.manage',
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

function globalSearch(q) { if (q.length < 2) return; toast('Search across modules coming soon: "' + q + '"', 'info', 1500); }
function showNotifications() { toast('You have no new notifications', 'info'); }
function openUserMenu() { toast('Signed in as: ' + App.user.name + ' (' + App.user.role + ')', 'info'); }

// ── Shared cross-page modal actions ───────────────────────────────────────
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
  WSClient.on('connected', () => { /* no-op, status dot already updates */ });
}

window.addEventListener('DOMContentLoaded', () => {
  tryRestoreSession();
});
