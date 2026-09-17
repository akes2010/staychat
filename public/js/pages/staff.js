// public/js/pages/staff.js
window.PAGES = window.PAGES || {};

PAGES.staff = function () {
  const wrap = el('div', 'fa');
  const state = { staff: [], filterDept: 'all', searchQ: '' };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading staff…');
    try { state.staff = await API.get('/api/staff'); render(); }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'staff\')'); }
  }

  function render() {
    const depts = ['all', 'Housekeeping', 'Kitchen', 'Maintenance', 'Front Desk'];
    const filtered = state.staff.filter(s => {
      if (state.filterDept !== 'all' && s.department !== state.filterDept) return false;
      if (state.searchQ && !s.name.toLowerCase().includes(state.searchQ.toLowerCase())) return false;
      return true;
    });
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Staff Directory</h1><p>' + state.staff.filter(s => s.status === 'active').length + ' on shift &middot; ' + state.staff.length + ' total</p></div>' +
      '<button class="btn primary" onclick="window.__openAddStaff()">+ Add Staff</button></div>' +
    '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center">' +
      '<div style="display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-full);padding:7px 14px;flex:1;max-width:260px">' +
        '<span>🔍</span><input value="' + escapeHtml(state.searchQ) + '" placeholder="Search staff…" oninput="window.__staffSearch(this.value)" style="border:none;outline:none;font-size:13px;color:var(--text);background:transparent;width:100%"/></div>' +
      '<div class="filter-pills" style="margin:0">' + depts.map(d => '<span class="pill' + (state.filterDept === d ? ' active' : '') + '" onclick="window.__staffFilter(\'' + d + '\')">' + (d === 'all' ? 'All' : d) + '</span>').join('') + '</div></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px">' +
      filtered.map(s => '<div class="staff-card">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between"><div class="staff-avatar">' + s.name.split(' ').map(n => n[0]).join('').slice(0, 2) + '</div>' + statusBadge(s.status) + '</div>' +
        '<div class="staff-name">' + escapeHtml(s.name) + '</div><div class="staff-role">' + escapeHtml(s.role) + ' &middot; ' + escapeHtml(s.department) + '</div>' +
        '<div class="staff-stats"><div class="staff-stat"><div class="staff-stat-val">' + s.tasks_completed + '</div><div class="staff-stat-key">Tasks</div></div><div class="staff-stat"><div class="staff-stat-val">' + escapeHtml(s.avg_time) + '</div><div class="staff-stat-key">Avg Time</div></div></div>' +
        '<div style="height:1px;background:var(--border);margin-bottom:12px"></div>' +
        '<div style="display:flex;gap:8px"><button class="btn primary sm" style="flex:1;justify-content:center" onclick="window.__messageStaff(\'' + s.id + '\')">Message</button><button class="btn outline sm" onclick="window.__editStaff(\'' + s.id + '\')">Edit</button></div></div>').join('') +
      (filtered.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">👥</div><div class="empty-state-title">No staff found</div></div>' : '') +
    '</div>';
  }

  window.__staffFilter = (d) => { state.filterDept = d; render(); };
  window.__staffSearch = (v) => { state.searchQ = v; render(); };
  window.__messageStaff = (id) => { const s = state.staff.find(x => x.id === id); toast('WhatsApp opened for ' + (s ? s.name : ''), 'success'); };

  window.__editStaff = (id) => {
    const s = state.staff.find(x => x.id === id);
    if (!s) return;
    openModal('Edit Staff Member',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="es-name" value="' + escapeHtml(s.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Role</label><input class="form-input" id="es-role" value="' + escapeHtml(s.role) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Department</label><select class="form-select" id="es-dept">' + ['Housekeeping','Kitchen','Maintenance','Front Desk'].map(d => '<option' + (s.department === d ? ' selected' : '') + '>' + d + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Shift</label><select class="form-select" id="es-shift">' + ['Morning','Afternoon','Night'].map(sh => '<option' + (s.shift === sh ? ' selected' : '') + '>' + sh + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="es-phone" value="' + escapeHtml(s.phone || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Status</label><select class="form-select" id="es-status">' + ['active','break','busy','off-duty'].map(st => '<option value="' + st + '"' + (s.status === st ? ' selected' : '') + '>' + st.charAt(0).toUpperCase() + st.slice(1) + '</option>').join('') + '</select></div></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger sm" onclick="window.__deleteStaff(\'' + id + '\')">Delete</button><button class="btn primary" onclick="window.__saveStaff(\'' + id + '\')">Save</button>'
    );
  };
  window.__saveStaff = async (id) => {
    try {
      await API.patch('/api/staff/' + id, {
        name: document.getElementById('es-name').value, role: document.getElementById('es-role').value, department: document.getElementById('es-dept').value,
        shift: document.getElementById('es-shift').value, phone: document.getElementById('es-phone').value, status: document.getElementById('es-status').value,
      });
      toast('Staff updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteStaff = (id) => {
    confirmAction('Delete this staff member?', async () => {
      try { await API.del('/api/staff/' + id); toast('Staff deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__openAddStaff = () => {
    openModal('Add New Staff Member',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="as-name" placeholder="e.g. John Doe"/></div>' +
        '<div class="form-group"><label class="form-label">Role / Title</label><input class="form-input" id="as-role" placeholder="e.g. Housekeeper"/></div>' +
        '<div class="form-group"><label class="form-label">Department</label><select class="form-select" id="as-dept"><option>Housekeeping</option><option>Kitchen</option><option>Maintenance</option><option>Front Desk</option></select></div>' +
        '<div class="form-group"><label class="form-label">Shift</label><select class="form-select" id="as-shift"><option>Morning</option><option>Afternoon</option><option>Night</option></select></div>' +
        '<div class="form-group"><label class="form-label">Phone (WhatsApp)</label><input class="form-input" id="as-phone" placeholder="+1 555 0000"/></div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="as-email" placeholder="staff@hotel.com"/></div></div>' +
      '<div class="toggle-wrap" style="margin-top:14px"><div class="toggle-info"><div class="toggle-label">Create login account</div><div class="toggle-desc">Gives this staff member their own dashboard access</div></div><label class="toggle"><input type="checkbox" id="as-create-login"><span class="toggle-slider"></span></label></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addStaff()">Add Staff Member</button>'
    );
  };
  window.__addStaff = async () => {
    const name = document.getElementById('as-name').value.trim();
    if (!name) { toast('Name required', 'error'); return; }
    try {
      const result = await API.post('/api/staff', {
        name, role: document.getElementById('as-role').value || 'Staff', department: document.getElementById('as-dept').value,
        shift: document.getElementById('as-shift').value, phone: document.getElementById('as-phone').value, email: document.getElementById('as-email').value,
        createLogin: document.getElementById('as-create-login').checked,
      });
      if (result.tempPassword) {
        toast('Staff added! Login: ' + document.getElementById('as-email').value + ' / ' + result.tempPassword, 'success', 8000);
      } else {
        toast('Staff member added', 'success');
      }
      closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
