// public/js/pages/shifts.js
// Shift & Attendance Management — define recurring shifts, clock staff in/out,
// and review the daily roster / attendance summary.
window.PAGES = window.PAGES || {};

PAGES.shifts = function () {
  const wrap = el('div', 'fa');
  const state = { date: new Date().toISOString().slice(0, 10), shifts: [], attendance: [], staffList: [] };
  const canManageShifts = typeof can === 'function' ? can('shifts.manage') : true;

  async function load() {
    wrap.innerHTML = loaderHTML('Loading shifts & attendance…');
    try {
      const [shifts, attendance, staffList] = await Promise.all([
        API.get('/api/shifts'), API.get('/api/shifts/attendance?date=' + state.date), API.get('/api/staff'),
      ]);
      state.shifts = shifts; state.attendance = attendance; state.staffList = staffList;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'shifts\')'); }
  }

  function statusColor(s) { return { present: 'success', late: 'warn', absent: 'error', on_leave: 'default' }[s] || 'default'; }

  function render() {
    const clockedIn = state.attendance.filter(a => a.clock_in && !a.clock_out).length;
    const present = state.attendance.filter(a => a.status === 'present' || a.status === 'late').length;

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Shifts &amp; Attendance</h1><p>' + fmtDate(state.date) + ' &middot; ' + state.attendance.length + ' records</p></div>' +
      '<div style="display:flex;gap:10px">' +
        (canManageShifts ? '<button class="btn outline" onclick="window.__manageShifts()">Manage Shifts</button>' : '') +
        '<button class="btn primary" onclick="window.__openClockIn()">+ Clock In</button>' +
      '</div></div>' +
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap">' +
      '<input type="date" class="form-input" style="max-width:180px" value="' + state.date + '" onchange="window.__attDateChange(this.value)"/>' +
      '<button class="btn outline sm" onclick="window.__attDateChange(\'' + new Date().toISOString().slice(0, 10) + '\')">Today</button>' +
    '</div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      metricCard('Currently Clocked In', String(clockedIn), null, '🟢') +
      metricCard('Present / Late Today', String(present), null, '🧑\u200d💼') +
      metricCard('Active Shifts', String(state.shifts.filter(s => s.active).length), null, '🕐') +
    '</div>' +
    (state.attendance.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🕐</div><div class="empty-state-title">No attendance records for this date</div></div>' :
    '<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Shift</th><th>Clock In</th><th>Clock Out</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      state.attendance.map(a => '<tr>' +
        '<td style="font-weight:600">' + escapeHtml(a.staff_name) + '</td>' +
        '<td style="font-size:12px;color:var(--text3)">' + escapeHtml(a.shift_name || '—') + '</td>' +
        '<td>' + (a.clock_in || '—') + '</td>' +
        '<td>' + (a.clock_out || '—') + '</td>' +
        '<td>' + badge(a.status.replace('_', ' '), statusColor(a.status)) + '</td>' +
        '<td>' + (a.clock_in && !a.clock_out ? '<button class="btn ghost sm" onclick="window.__clockOut(\'' + a.id + '\')">Clock Out</button>' : '') + '</td>' +
      '</tr>').join('') + '</tbody></table></div>');
  }

  function fmtDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }

  window.__attDateChange = (v) => { state.date = v; load(); };

  window.__openClockIn = () => {
    const available = state.staffList.filter(s => !state.attendance.some(a => a.staff_id === s.id));
    openModal('Clock In',
      '<div class="form-group"><label class="form-label">Staff Member</label><select class="form-select" id="ci-staff">' +
        '<option value="">— Myself (' + escapeHtml(App.user ? App.user.name : '') + ') —</option>' +
        available.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + ' — ' + escapeHtml(s.role) + '</option>').join('') +
      '</select></div>' +
      '<div class="form-group"><label class="form-label">Shift (optional)</label><select class="form-select" id="ci-shift"><option value="">— No shift —</option>' +
        state.shifts.filter(s => s.active).map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + ' (' + s.start_time + '–' + s.end_time + ')</option>').join('') +
      '</select></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__doClockIn()">Clock In</button>'
    );
  };
  window.__doClockIn = async () => {
    try {
      await API.post('/api/shifts/attendance/clock-in', { staffId: document.getElementById('ci-staff').value || undefined, shiftId: document.getElementById('ci-shift').value || undefined });
      toast('Clocked in', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__clockOut = async (id) => {
    try { await API.post('/api/shifts/attendance/' + id + '/clock-out'); toast('Clocked out', 'success'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  // ── Manage shift definitions ──────────────────────────────────────────
  window.__manageShifts = () => {
    openModal('Manage Shifts',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.shifts.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No shifts defined yet.</div>' :
        state.shifts.map(s => '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(s.name) + '</div><div style="font-size:11px;color:var(--text3)">' + s.start_time + ' – ' + s.end_time + ' &middot; ' + escapeHtml(s.department) + '</div></div>' +
          (s.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteShift(\'' + s.id + '\')">Delete</button></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Shift</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="as-name" placeholder="e.g. Morning"/></div>' +
          '<div class="form-group"><label class="form-label">Department</label><input class="form-input" id="as-dept" placeholder="e.g. Front Desk / All"/></div>' +
          '<div class="form-group"><label class="form-label">Start Time</label><input class="form-input" type="time" id="as-start" value="07:00"/></div>' +
          '<div class="form-group"><label class="form-label">End Time</label><input class="form-input" type="time" id="as-end" value="15:00"/></div>' +
        '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addShift()">Add Shift</button>'
    );
  };
  window.__addShift = async () => {
    const name = document.getElementById('as-name').value.trim();
    if (!name) { toast('Shift name is required', 'error'); return; }
    try {
      await API.post('/api/shifts', { name, startTime: document.getElementById('as-start').value, endTime: document.getElementById('as-end').value, department: document.getElementById('as-dept').value.trim() || 'All' });
      toast('Shift added', 'success'); await load(); window.__manageShifts();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteShift = (id) => {
    confirmAction('Delete this shift?', async () => {
      try { await API.del('/api/shifts/' + id); toast('Shift deleted', 'warn'); await load(); window.__manageShifts(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
