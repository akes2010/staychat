// public/js/pages/shifts.js
// Shift & Attendance Management — define recurring shifts, clock staff in/out,
// review the daily roster / attendance summary, and run the rotating DUTY
// ROTATION calendar (which department holds duty on which dates).
window.PAGES = window.PAGES || {};

PAGES.shifts = function () {
  const wrap = el('div', 'fa');
  const state = { date: new Date().toISOString().slice(0, 10), shifts: [], attendance: [], staffList: [], rotation: null, calendar: null };
  const canManageShifts = typeof can === 'function' ? can('shifts.manage') : true;
  const todayIso = () => new Date().toISOString().slice(0, 10);

  async function load() {
    wrap.innerHTML = loaderHTML('Loading shifts & attendance…');
    try {
      const today = todayIso();
      const [shifts, attendance, staffList, rotation, calendar] = await Promise.all([
        API.get('/api/shifts'), API.get('/api/shifts/attendance?date=' + state.date), API.get('/api/staff'),
        API.get('/api/shifts/rotation'), API.get('/api/shifts/rotation/calendar?from=' + today + '&to=' + new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10)),
      ]);
      state.shifts = shifts; state.attendance = attendance; state.staffList = staffList;
      state.rotation = rotation; state.calendar = calendar;
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
    rotationSectionHTML() +
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

  // ── Duty rotation section (rotating department calendar) ─────────────
  // One fixed color per department (by its position in the cycle) so the
  // calendar strip reads at a glance; block starts are tinted to show where
  // each department's run of days begins.
  const ROT_COLORS = ['#0A6DC2', '#7C3AED', '#D97706', '#0F766E', '#BE123C', '#4D7C0F', '#9333EA', '#0369A1'];
  function rotColor(dept) {
    const rot = state.rotation;
    const i = rot && rot.rotation ? rot.rotation.findIndex(r => r.department === dept) : -1;
    return ROT_COLORS[(i < 0 ? 0 : i) % ROT_COLORS.length];
  }
  function rotationSectionHTML() {
    const rot = state.rotation, cal = state.calendar;
    if (!rot || !rot.rotation || !rot.rotation.length || !cal || !cal.days || !cal.days.length) return '';
    const today = todayIso();
    const onDuty = cal.days.find(d => d.date === today) || cal.days[0];
    return '<div class="card" style="margin-bottom:20px">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
        '<div><div style="font-weight:700;font-size:14px">🔄 Duty Rotation <span style="font-weight:500;color:var(--text3);font-size:12px">— ' + rot.totalDays + '-day cycle · anchored ' + fmtDate(rot.anchorDate) + '</span></div>' +
        '<div style="font-size:12px;color:var(--text3);margin-top:2px">Today on duty: <b style="color:' + rotColor(onDuty.department) + '">' + escapeHtml(onDuty.department) + '</b> — day ' + onDuty.dayInBlock + ' of ' + onDuty.blockDays + ', through ' + fmtDate(onDuty.blockEnd) + '</div></div>' +
        (canManageShifts ? '<button class="btn outline sm" onclick="window.__manageRotation()">Manage Rotation</button>' : '') +
      '</div>' +
      '<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px">' +
        cal.days.map(d => {
          const c = rotColor(d.department);
          const dow = new Date(d.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
          const isToday = d.date === today;
          return '<div style="min-width:66px;flex-shrink:0;text-align:center;border:1.5px solid ' + (isToday ? c : 'var(--border)') + ';background:' + (d.dayInBlock === 1 ? c + '1A' : 'var(--surface)') + ';border-radius:9px;padding:6px 4px">' +
            '<div style="font-size:10px;color:var(--text3)">' + dow + ' ' + d.date.slice(8) + '</div>' +
            '<div style="font-size:11px;font-weight:700;color:' + c + '">' + escapeHtml(d.department) + '</div>' +
            '<div style="font-size:9.5px;color:var(--text3)">day ' + d.dayInBlock + '/' + d.blockDays + '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:10px">' +
        rot.rotation.map(r => '<span style="display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text3)"><span style="width:10px;height:10px;border-radius:3px;background:' + rotColor(r.department) + ';display:inline-block"></span>' + escapeHtml(r.department) + ' — ' + r.daysOn + ' day' + (r.daysOn === 1 ? '' : 's') + '</span>').join('') +
      '</div>' +
    '</div>';
  }

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

  // ── Manage duty rotation ─────────────────────────────────────────────
  // The editor works on a draft array; every re-render first captures what is
  // currently typed, so reordering/adding never loses edits in other rows.
  let rotDraft = [];
  function rotRowHtml(r, i) {
    return '<div class="rot-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
      '<input class="form-input rot-dept" value="' + escapeHtml(r.department || '') + '" placeholder="Department" style="flex:1"/>' +
      '<input class="form-input rot-days" type="number" min="1" max="30" value="' + (Number(r.daysOn) || 1) + '" style="width:84px" title="Shift days"/>' +
      '<span style="font-size:11px;color:var(--text3);width:34px">days</span>' +
      '<button class="btn ghost sm" onclick="window.__rotMove(' + i + ',-1)">↑</button>' +
      '<button class="btn ghost sm" onclick="window.__rotMove(' + i + ',1)">↓</button>' +
      '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__rotRemove(' + i + ')">✕</button>' +
    '</div>';
  }
  function syncRotDraft() {
    const rows = [...document.querySelectorAll('#rot-rows .rot-row')];
    rotDraft = rows.map(row => ({
      department: (row.querySelector('.rot-dept') || {}).value || '',
      daysOn: Number((row.querySelector('.rot-days') || {}).value || 1),
    }));
  }
  function updateRotTotal() {
    const total = rotDraft.reduce((s, r) => s + (Number(r.daysOn) || 0), 0);
    const el2 = document.getElementById('rot-total');
    if (el2) el2.textContent = 'Cycle length: ' + total + ' day' + (total === 1 ? '' : 's') + ' — repeats forever across the calendar';
  }
  function renderRotRows() {
    const box = document.getElementById('rot-rows');
    if (box) box.innerHTML = rotDraft.length ? rotDraft.map((r, i) => rotRowHtml(r, i)).join('') : '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">No departments yet — add the first one below.</div>';
    updateRotTotal();
  }
  window.__rotAddRow = () => { syncRotDraft(); rotDraft.push({ department: '', daysOn: 1 }); renderRotRows(); };
  window.__rotMove = (i, dir) => {
    syncRotDraft();
    const j = i + dir;
    if (j < 0 || j >= rotDraft.length) return;
    [rotDraft[i], rotDraft[j]] = [rotDraft[j], rotDraft[i]];
    renderRotRows();
  };
  window.__rotRemove = (i) => { syncRotDraft(); rotDraft.splice(i, 1); renderRotRows(); };
  window.__manageRotation = () => {
    rotDraft = ((state.rotation && state.rotation.rotation) || []).map(r => ({ department: r.department, daysOn: r.daysOn }));
    openModal('Manage Duty Rotation',
      '<p style="font-size:12px;color:var(--text3);margin-bottom:12px">Each department holds the duty for its number of consecutive days, then the next one takes over — the cycle repeats endlessly. Reorder with ↑ ↓, add any department.</p>' +
      '<div id="rot-rows"></div>' +
      '<button class="btn outline sm" style="margin-bottom:14px" onclick="window.__rotAddRow()">+ Add department</button>' +
      '<div class="form-group"><label class="form-label">Cycle starts on (anchor date)</label><input class="form-input" type="date" id="rot-anchor" value="' + escapeHtml((state.rotation && state.rotation.anchorDate) || todayIso()) + '"/></div>' +
      '<div id="rot-total" style="font-size:12px;font-weight:600;color:var(--text3)"></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveRotation()">Save Rotation</button>',
      { wide: true }
    );
    renderRotRows();
  };
  window.__saveRotation = async () => {
    syncRotDraft();
    const rotation = rotDraft
      .map(r => ({ department: String(r.department || '').trim(), daysOn: Number(r.daysOn) || 1 }))
      .filter(r => r.department);
    if (!rotation.length) { toast('Add at least one department to the rotation', 'error'); return; }
    try {
      await API.put('/api/shifts/rotation', { rotation, anchorDate: document.getElementById('rot-anchor').value });
      toast('Duty rotation updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
