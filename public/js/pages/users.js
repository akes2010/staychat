// public/js/pages/users.js
// User Management & Permissions — hotel_admin/superadmin only. Every
// capability checkbox is fully editable: role just supplies a sensible
// starting point, and the owner/manager can customize any user's complete
// permission set from there (or reset back to the role's plain defaults).
window.PAGES = window.PAGES || {};

const CAPABILITY_LABELS = {
  'dashboard.view': 'View Dashboard', 'rooms.manage': 'Manage Rooms (day-to-day)',
  'pricing.manage': 'Manage Floors, Categories & Pricing', 'inbox.use': 'Use WhatsApp Inbox',
  'orders.manage': 'Manage Room Service Orders', 'pos.use': 'Use Point of Sale', 'pos.manage_products': 'Manage POS Products',
  'bookings.manage': 'Manage Bookings & Reservations',
  'pool.use': 'Book / Operate Pool', 'pool.manage': 'Manage Pools, Pricing & Cancellations',
  'halls.use': 'Book / Operate Halls', 'halls.manage': 'Manage Halls, Pricing & Cancellations',
  'gym.use': 'Book / Register Gym Members', 'gym.manage': 'Manage Gyms, Pricing & Cancellations',
  'tables.use': 'View Tables & Seating', 'tables.manage': 'Manage Tables, Sitting Settings & Active Flags',
  'housekeeping.manage': 'Manage Housekeeping', 'maintenance.manage': 'Manage Maintenance', 'guests.manage': 'Manage Guests',
  'analytics.view': 'View Analytics', 'staff.manage': 'Manage Staff Directory',
  'shifts.manage': 'Define Shifts', 'attendance.use': 'Clock In / Out',
  'eod.use': 'Submit Own End of Day', 'eod.manage': 'View / Reopen All End of Day Closings',
  'menu.manage': 'Manage Menu',
  'payments.use': 'View Payments / Create Links', 'payments.manage': 'Change Payment Status & Refunds',
  'accounting.view': 'View Accounting Reports', 'accounting.manage': 'Post Journal Entries & Vouchers',
  'ai.manage': 'Configure AI Agents', 'printers.manage': 'Manage Printers',
  'settings.manage': 'Manage Settings', 'users.manage': 'Manage Users & Permissions',
};

const ROLE_OPTIONS = [
  ['staff', 'Staff'], ['receptionist', 'Receptionist'], ['porter', 'Porter (Front Office)'], ['hotel_admin', 'Hotel Admin'],
  ['cashier', 'Cashier (POS — Restaurant)'], ['barman', 'Barman (POS — Bar)'],
  ['waiter', 'Waiter (POS — Bar)'], ['server', 'Server (POS — Restaurant)'],
  ['accountant', 'Accountant'], ['auditor', 'Auditor (read-only)'],
];

// Suggestions offered in the Department field. Custom departments created
// under "Roles & Departments" are merged in at render time, and typing any
// other value still works — users.department has always been free text.
const DEPARTMENT_SUGGESTIONS = [
  'Front Desk', 'Front Office', 'Bar', 'Restaurant', 'Housekeeping', 'Kitchen',
  'Maintenance', 'Pool', 'Hall', 'Gym', 'Spa', 'Laundry',
];

PAGES.users = function () {
  const wrap = el('div', 'fa');
  const state = { users: [], capabilities: [], roleDefaults: {}, customRoles: [], departments: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading users…');
    try {
      const [users, capData, customRoles, departments] = await Promise.all([
        API.get('/api/users'), API.get('/api/users/capabilities'),
        API.get('/api/users/roles'), API.get('/api/users/departments'),
      ]);
      state.users = users; state.capabilities = capData.capabilities; state.roleDefaults = capData.roleDefaults;
      state.customRoles = customRoles; state.departments = departments;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'users\')'); }
  }

  const roleBadge = (r) => ({
    hotel_admin: badge('Hotel Admin', 'info'), receptionist: badge('Receptionist', 'success'), staff: badge('Staff', 'default'),
    superadmin: badge('Super Admin', 'warn'), cashier: badge('Cashier', 'info'), barman: badge('Barman', 'info'),
    waiter: badge('Waiter', 'info'), server: badge('Server', 'info'), porter: badge('Porter', 'info'),
    accountant: badge('Accountant', 'success'), auditor: badge('Auditor', 'default'),
  }[r] || badge((state.customRoles.find(c => c.key === r) || {}).name || r, 'success'));

  function render() {
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>User Management &amp; Permissions</h1><p>' + state.users.length + ' users in this hotel</p></div>' +
      '<button class="btn primary" onclick="window.__openAddUser()">+ Invite User</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Department</th><th>Permissions</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead><tbody>' +
      state.users.map(u => '<tr style="opacity:' + (u.active ? 1 : .55) + '">' +
        '<td><div style="display:flex;align-items:center;gap:10px">' +
          '<div style="width:32px;height:32px;border-radius:99px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;color:var(--p)">' + escapeHtml(u.avatar || u.name.slice(0, 2).toUpperCase()) + '</div>' +
          '<div><div style="font-weight:600;font-size:13px">' + escapeHtml(u.name) + '</div><div style="font-size:11px;color:var(--text3)">' + escapeHtml(u.email) + '</div></div></div></td>' +
        '<td>' + roleBadge(u.role) + '</td>' +
        '<td style="font-size:12px;color:var(--text3)">' + escapeHtml(u.department || '—') + '</td>' +
        '<td>' + (u.permissionsCustomized ? badge('Customized', 'warn') : badge('Role Default', 'default')) + '</td>' +
        '<td>' + (u.active ? badge('Active', 'success') : badge('Deactivated', 'error')) + '</td>' +
        '<td style="font-size:12px;color:var(--text3)">' + (u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never') + '</td>' +
        '<td><div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn ghost sm" onclick="window.__editUser(\'' + u.id + '\')">Edit / Permissions</button>' +
          '<button class="btn ghost sm" onclick="window.__resetPassword(\'' + u.id + '\')">Reset Password</button>' +
          (u.active ? '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deactivateUser(\'' + u.id + '\')">Deactivate</button>' : '<button class="btn ghost sm" style="color:var(--a)" onclick="window.__reactivateUser(\'' + u.id + '\')">Reactivate</button>') +
        '</div></td>' +
      '</tr>').join('') +
    '</tbody></table></div>' +
    manageSectionHTML();
  }

  // ── Roles & Departments — admin-defined additions ────────────────────
  // Built-in roles/departments are never modified here; this only manages the
  // tenant's own custom rows (see server/routes/users.js), so extending the
  // system can't disturb what already ships.
  function deptOptionsHTML() {
    const names = DEPARTMENT_SUGGESTIONS.concat(state.departments.map(d => d.name));
    return Array.from(new Set(names)).map(n => '<option value="' + escapeHtml(n) + '">').join('');
  }

  function manageSectionHTML() {
    const none = '<div style="font-size:12px;color:var(--text3);padding:6px 0">None yet.</div>';
    return '<div class="card" style="margin-top:20px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
        '<div><div style="font-weight:700;font-size:15px">Roles &amp; Departments</div>' +
        '<div style="font-size:12px;color:var(--text3)">Add your own — they appear in the pickers above. Built-ins stay untouched.</div></div>' +
        '<div style="display:flex;gap:8px">' +
          '<button class="btn outline sm" onclick="window.__openAddDept()">+ Department</button>' +
          '<button class="btn outline sm" onclick="window.__openAddRole()">+ Role</button>' +
        '</div>' +
      '</div>' +
      '<div class="grid grid-2">' +
        '<div><div class="form-label" style="margin-bottom:6px">Departments (' + state.departments.length + ' custom)</div>' +
          (state.departments.length ? state.departments.map(d =>
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--surface2);font-size:13px">' +
              '<span>' + escapeHtml(d.icon || '🏷') + ' ' + escapeHtml(d.name) + ' <span style="color:var(--text3);font-size:11px">(' + escapeHtml(d.key) + ')</span></span>' +
              '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteDept(\'' + d.id + '\')">Remove</button>' +
            '</div>').join('') : none) +
        '</div>' +
        '<div><div class="form-label" style="margin-bottom:6px">Roles (' + state.customRoles.length + ' custom)</div>' +
          (state.customRoles.length ? state.customRoles.map(r =>
            '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--surface2);font-size:13px">' +
              '<span>' + escapeHtml(r.name) + ' <span style="color:var(--text3);font-size:11px">(' + escapeHtml(r.key) + ' · ' + r.permissions.length + ' permissions)</span></span>' +
              '<span style="display:flex;gap:4px">' +
                '<button class="btn ghost sm" onclick="window.__editRole(\'' + r.id + '\')">Edit</button>' +
                '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteRole(\'' + r.id + '\')">Remove</button>' +
              '</span>' +
            '</div>').join('') : none) +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function roleSelectHTML(id, current, onchange) {
    const options = ROLE_OPTIONS.concat(state.customRoles.map(r => [r.key, r.name + ' (custom)']));
    return '<select class="form-select" id="' + id + '" onchange="' + onchange + '">' +
      options.map(([val, label]) => '<option value="' + val + '"' + (current === val ? ' selected' : '') + '>' + escapeHtml(label) + '</option>').join('') +
    '</select>';
  }

  // ── Invite new user ──────────────────────────────────────────────────
  window.__openAddUser = () => {
    openModal('Invite User',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="au-name" placeholder="Jane Doe"/></div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="au-email" placeholder="jane@hotel.com"/></div>' +
        '<div class="form-group"><label class="form-label">Temporary Password</label><input class="form-input" id="au-pass" placeholder="Min 6 characters"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="au-phone" placeholder="+234…"/></div>' +
        '<div class="form-group"><label class="form-label">Role</label>' + roleSelectHTML('au-role', 'staff', "window.__renderCapChecklist('au')") + '</div>' +
        '<div class="form-group"><label class="form-label">Department</label><input class="form-input" id="au-dept" placeholder="e.g. Front Desk" list="dept-suggestions"/></div>' +
      '</div>' +
      '<div style="margin-top:8px"><div class="form-label" style="margin-bottom:8px">Permissions <span style="font-weight:400;color:var(--text3)">(pre-checked from the role — edit freely)</span></div>' +
        '<div id="au-caps"></div></div>' +
      '<datalist id="dept-suggestions">' + deptOptionsHTML() + '</datalist>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addUser()">Send Invite</button>',
      { wide: true }
    );
    window.__renderCapChecklist('au');
  };

  window.__renderCapChecklist = (prefix, checkedSet) => {
    const role = document.getElementById(prefix + '-role').value;
    const checked = checkedSet || state.roleDefaults[role] || [];
    const box = document.getElementById(prefix + '-caps');
    box.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:6px;max-height:240px;overflow-y:auto;padding:4px;background:var(--surface2);border-radius:9px">' +
      state.capabilities.map(c => '<label style="display:flex;align-items:center;gap:8px;font-size:12px">' +
          '<input type="checkbox" data-cap="' + c + '" ' + (checked.includes(c) ? 'checked' : '') + '/>' +
          escapeHtml(CAPABILITY_LABELS[c] || c) +
        '</label>').join('') +
    '</div>';
  };

  function readCaps(prefix) {
    return Array.from(document.querySelectorAll('#' + prefix + '-caps input[type=checkbox]:checked')).map(i => i.dataset.cap);
  }

  window.__addUser = async () => {
    const name = document.getElementById('au-name').value.trim();
    const email = document.getElementById('au-email').value.trim();
    const password = document.getElementById('au-pass').value;
    if (!name || !email || !password) { toast('Name, email, and password are required', 'error'); return; }
    try {
      await API.post('/api/users', {
        name, email, password, role: document.getElementById('au-role').value,
        department: document.getElementById('au-dept').value.trim(), phone: document.getElementById('au-phone').value.trim(),
        permissions: readCaps('au'),
      });
      toast('User invited', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Edit user / permissions ──────────────────────────────────────────
  window.__editUser = (id) => {
    const u = state.users.find(x => x.id === id);
    if (!u) return;
    openModal('Edit User — ' + escapeHtml(u.name),
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="eu-name" value="' + escapeHtml(u.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" value="' + escapeHtml(u.email) + '" disabled/></div>' +
        '<div class="form-group"><label class="form-label">Department</label><input class="form-input" id="eu-dept" value="' + escapeHtml(u.department || '') + '" list="dept-suggestions"/></div>' +
        '<div class="form-group"><label class="form-label">Role</label>' + roleSelectHTML('eu-role', u.role, "window.__renderCapChecklist('eu', window.__roleDefaultsFor('eu'))") + '</div>' +
      '</div>' +
      '<div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between">' +
        '<div class="form-label" style="margin-bottom:0">Permissions ' + (u.permissionsCustomized ? badge('Customized', 'warn') : badge('Role Default', 'default')) + '</div>' +
        '<button class="btn ghost sm" onclick="window.__renderCapChecklist(\'eu\')">Reset checklist to role defaults</button>' +
      '</div>' +
      '<div id="eu-caps" style="margin-top:8px"></div>' +
      '<datalist id="dept-suggestions">' + deptOptionsHTML() + '</datalist>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveUser(\'' + id + '\')">Save Changes</button>',
      { wide: true }
    );
    window.__renderCapChecklist('eu', u.effectivePermissions);
  };
  window.__roleDefaultsFor = (prefix) => state.roleDefaults[document.getElementById(prefix + '-role').value] || [];
  window.__saveUser = async (id) => {
    try {
      await API.patch('/api/users/' + id, {
        name: document.getElementById('eu-name').value.trim(), department: document.getElementById('eu-dept').value.trim(),
        role: document.getElementById('eu-role').value, permissions: readCaps('eu'),
      });
      toast('User updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__resetPassword = (id) => {
    const u = state.users.find(x => x.id === id);
    openModal('Reset Password — ' + escapeHtml(u.name),
      '<div class="form-group"><label class="form-label">New Temporary Password</label><input class="form-input" id="rp-pass" placeholder="Min 6 characters"/></div>' +
      '<p style="font-size:12px;color:var(--text3);margin-top:8px">This immediately signs the user out everywhere. Share the new password with them securely.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__doResetPassword(\'' + id + '\')">Reset Password</button>'
    );
  };
  window.__doResetPassword = async (id) => {
    const password = document.getElementById('rp-pass').value;
    if (!password || password.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
    try { await API.post('/api/users/' + id + '/reset-password', { password }); toast('Password reset', 'success'); closeModal(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__deactivateUser = (id) => {
    confirmAction('Deactivate this user? They will be signed out and unable to log in.', async () => {
      try { await API.del('/api/users/' + id); toast('User deactivated', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__reactivateUser = async (id) => {
    try { await API.patch('/api/users/' + id, { active: true }); toast('User reactivated', 'success'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  // ── Custom role management ──────────────────────────────────────────
  window.__openAddRole = () => {
    openModal('New Custom Role',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Role Name</label><input class="form-input" id="cr-name" placeholder="e.g. Spa Attendant"/></div>' +
        '<div class="form-group"><label class="form-label">Department <span style="font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input" id="cr-dept" placeholder="e.g. Spa" list="dept-suggestions"/></div>' +
        '<div class="form-group"><label class="form-label">Start From (template)</label>' + roleSelectHTML('cr-role', 'staff', "window.__renderCapChecklist('cr')") + '</div>' +
      '</div>' +
      '<div style="margin-top:8px"><div class="form-label" style="margin-bottom:8px">Permissions <span style="font-weight:400;color:var(--text3)">(pre-checked from the template — edit freely)</span></div>' +
        '<div id="cr-caps"></div></div>' +
      '<datalist id="dept-suggestions">' + deptOptionsHTML() + '</datalist>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveNewRole()">Create Role</button>',
      { wide: true }
    );
    window.__renderCapChecklist('cr');
  };
  window.__saveNewRole = async () => {
    const name = document.getElementById('cr-name').value.trim();
    if (!name) { toast('Role name is required', 'error'); return; }
    try {
      await API.post('/api/users/roles', {
        name, department: document.getElementById('cr-dept').value.trim() || undefined,
        permissions: readCaps('cr'),
      });
      toast('Custom role created — pick it in the Role dropdown', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__editRole = (id) => {
    const r = state.customRoles.find(x => x.id === id);
    if (!r) return;
    openModal('Edit Role — ' + escapeHtml(r.name),
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Role Name</label><input class="form-input" id="cr-name" value="' + escapeHtml(r.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Department <span style="font-weight:400;color:var(--text3)">(optional)</span></label><input class="form-input" id="cr-dept" value="' + escapeHtml(r.department || '') + '" list="dept-suggestions"/></div>' +
        '<div class="form-group"><label class="form-label">Start From (template)</label>' + roleSelectHTML('cr-role', 'staff', "window.__renderCapChecklist('cr')") + '</div>' +
      '</div>' +
      '<div style="margin-top:8px"><div class="form-label" style="margin-bottom:8px">Permissions <span style="font-weight:400;color:var(--text3)">(edit freely — holders are signed out to pick up changes)</span></div>' +
        '<div id="cr-caps"></div></div>' +
      '<datalist id="dept-suggestions">' + deptOptionsHTML() + '</datalist>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveEditRole(\'' + r.id + '\')">Save Changes</button>',
      { wide: true }
    );
    window.__renderCapChecklist('cr', r.permissions);
  };
  window.__saveEditRole = async (id) => {
    const name = document.getElementById('cr-name').value.trim();
    if (!name) { toast('Role name is required', 'error'); return; }
    try {
      await API.patch('/api/users/roles/' + id, {
        name, department: document.getElementById('cr-dept').value.trim(),
        permissions: readCaps('cr'),
      });
      toast('Role updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteRole = (id) => {
    const r = state.customRoles.find(x => x.id === id);
    if (!r) return;
    confirmAction('Remove the "' + r.name + '" role? Active users still holding it must be reassigned first.', async () => {
      try { await API.del('/api/users/roles/' + id); toast('Role removed', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Custom department management ────────────────────────────────────
  window.__openAddDept = () => {
    openModal('New Department',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Department Name</label><input class="form-input" id="nd-name" placeholder="e.g. Spa & Wellness"/></div>' +
        '<div class="form-group"><label class="form-label">Icon <span style="font-weight:400;color:var(--text3)">(emoji, optional)</span></label><input class="form-input" id="nd-icon" placeholder="💆" maxlength="4"/></div>' +
      '</div>' +
      '<p style="font-size:12px;color:var(--text3);margin-top:8px">Appears as a suggestion in the Department field when inviting or editing users.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveNewDept()">Create Department</button>'
    );
  };
  window.__saveNewDept = async () => {
    const name = document.getElementById('nd-name').value.trim();
    if (!name) { toast('Department name is required', 'error'); return; }
    try {
      await API.post('/api/users/departments', { name, icon: document.getElementById('nd-icon').value.trim() || undefined });
      toast('Department created', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteDept = (id) => {
    const d = state.departments.find(x => x.id === id);
    if (!d) return;
    confirmAction('Remove the "' + d.name + '" department? Users already assigned keep their label.', async () => {
      try { await API.del('/api/users/departments/' + id); toast('Department removed', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
