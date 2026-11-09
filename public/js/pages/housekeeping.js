// public/js/pages/housekeeping.js
window.PAGES = window.PAGES || {};

PAGES.housekeeping = function () {
  const wrap = el('div', 'fa');
  const state = { rooms: [], staff: [], today: { count: 0, byStaff: [], entries: [] }, assigned: {} };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading housekeeping…');
    try {
      const [rooms, staff, today] = await Promise.all([
        API.get('/api/rooms'),
        API.get('/api/staff'),
        API.get('/api/rooms/housekeeping/today'),
      ]);
      state.rooms = rooms; state.staff = staff;
      state.today = today || { count: 0, byStaff: [], entries: [] };
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'housekeeping\')'); }
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z'));
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function render() {
    const dirty = state.rooms.filter(r => r.status === 'dirty');
    const cleaning = state.rooms.filter(r => r.status === 'cleaning');
    const available = state.rooms.filter(r => r.status === 'available');
    const hkStaff = state.staff.filter(s => s.department === 'Housekeeping');
    const cleanedToday = state.today.count || 0;
    const signedOff = (state.today.rooms || []).length;
    const entries = state.today.entries || [];

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Housekeeping</h1><p>' + dirty.length + ' dirty &middot; ' + cleaning.length + ' in progress &middot; ' + cleanedToday + ' cleaned today &middot; ' + available.length + ' clean &amp; ready</p></div></div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      '<div class="metric-card"><div class="metric-top"><div class="metric-icon" style="background:#fef2f2">🚨</div></div><div class="metric-label">Needs Cleaning</div><div class="metric-value">' + dirty.length + '</div></div>' +
      '<div class="metric-card"><div class="metric-top"><div class="metric-icon" style="background:#eff6ff">🔄</div></div><div class="metric-label">In Progress</div><div class="metric-value">' + cleaning.length + '</div></div>' +
      '<div class="metric-card"><div class="metric-top"><div class="metric-icon" style="background:#f0fdf4">✅</div></div><div class="metric-label">Rooms Cleaned Today</div><div class="metric-value">' + cleanedToday + '</div><div style="font-size:11px;color:var(--text3)">' + signedOff + ' room' + (signedOff === 1 ? '' : 's') + ' signed off</div></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">' +
      '<div class="card" style="padding:0;overflow:hidden">' +
        '<div style="padding:13px 16px;background:#fef2f2;border-bottom:1px solid var(--error-border);display:flex;align-items:center;gap:8px">' +
          '<span style="font-size:16px">🚨</span><span style="font-weight:700;font-size:14px">Needs Cleaning</span><span class="badge error" style="margin-left:auto">' + dirty.length + '</span></div>' +
        (dirty.length === 0 ? '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">All rooms are clean</div>' : '') +
        dirty.map(room => '<div style="padding:13px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">' +
          '<div style="width:36px;height:36px;border-radius:8px;background:var(--warn-bg);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:var(--warn)">' + escapeHtml(room.number) + '</div>' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(room.type) + '</div><div style="font-size:11px;color:var(--text3)">' + escapeHtml(room.view || '') + ' &middot; Floor ' + room.floor + '</div></div>' +
          '<button class="btn accent sm" onclick="window.__assignHKRoom(\'' + room.id + '\')">Assign</button></div>').join('') +
      '</div>' +
      '<div class="card" style="padding:0;overflow:hidden">' +
        '<div style="padding:13px 16px;background:var(--info-bg);border-bottom:1px solid var(--info-border);display:flex;align-items:center;gap:8px">' +
          '<div class="pulse-dot" style="width:8px;height:8px;border-radius:99px;background:var(--a)"></div><span style="font-weight:700;font-size:14px">Being Cleaned</span><span class="badge info" style="margin-left:auto">' + cleaning.length + '</span></div>' +
        (cleaning.length === 0 ? '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">No rooms being cleaned</div>' : '') +
        cleaning.map(room => '<div style="padding:13px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">' +
          '<div style="width:36px;height:36px;border-radius:8px;background:var(--info-bg);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:var(--info)">' + escapeHtml(room.number) + '</div>' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(room.type) + '</div><div style="font-size:11px;color:var(--text3)">In progress' + (state.assigned[room.id] ? ' &middot; ' + escapeHtml(state.assigned[room.id].name) : '') + '</div></div>' +
          '<button class="btn primary sm" onclick="window.__markRoomClean(\'' + room.id + '\')">Clean</button></div>').join('') +
      '</div>' +
    '</div>' +
    // ── Rooms cleaned today (the log) ──────────────────────────────────
    '<div class="card" style="margin-bottom:20px">' +
      '<div class="card-header"><span class="card-title">Rooms Cleaned Today</span><span style="font-size:12px;color:var(--text3)">' + cleanedToday + ' room' + (cleanedToday === 1 ? '' : 's') + '</span></div>' +
      (entries.length === 0
        ? '<div style="font-size:13px;color:var(--text3);padding:6px 0">No rooms signed off yet today.</div>'
        : '<div class="table-wrap"><table><thead><tr><th>Room</th><th>Cleaned by</th><th>Time</th><th>Remark</th></tr></thead><tbody>' +
          entries.map(e => '<tr>' +
            '<td style="font-weight:700">' + escapeHtml(e.room_number) + '</td>' +
            '<td>' + escapeHtml(e.staff_name || e.created_by || '—') + '</td>' +
            '<td style="font-size:12px;color:var(--text3)">' + fmtTime(e.created_at) + '</td>' +
            '<td style="font-size:12px">' + (e.remark ? escapeHtml(e.remark) : '<span style="color:var(--text3)">No remark</span>') + '</td>' +
          '</tr>').join('') + '</tbody></table></div>') +
    '</div>' +
    '<div class="card"><div class="card-header"><span class="card-title">Cleaned by Staff Today</span></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">' +
        ((state.today.byStaff || []).length === 0 ? '<div style="font-size:13px;color:var(--text3)">No rooms cleaned yet today</div>' : '') +
        (state.today.byStaff || []).map(s => '<div style="background:var(--surface2);border-radius:var(--radius);padding:14px;border:1px solid var(--border)">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:3px">' + escapeHtml(s.name) + '</div>' +
          '<div style="font-size:12px;color:var(--p);font-weight:700;margin-bottom:7px">' + s.count + ' room' + (s.count === 1 ? '' : 's') + ' cleaned</div>' + pbar(Math.min(100, s.count * 20), 'var(--a)') + '</div>').join('') +
        (hkStaff.length === 0 ? '<div style="font-size:11.5px;color:var(--text3)">Add housekeeping staff in Staff to track who cleaned each room.</div>' : '') +
      '</div></div>';
  }

  window.__assignHKRoom = (id) => {
    const hkActive = state.staff.filter(s => s.department === 'Housekeeping' && s.status === 'active');
    openModal('Assign Cleaning',
      '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Assign To</label><select class="form-select" id="hk-staff">' +
        (hkActive.length === 0 ? '<option value="">— Assign yourself —</option>' : hkActive.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + ' (' + s.tasks_completed + ' done today)</option>').join('')) +
      '</select></div>' +
      '<p style="font-size:11.5px;color:var(--text3)">The room moves to <b>Being Cleaned</b>. When it is done, sign it off with a remark — that is what the shift report counts.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn accent" onclick="window.__confirmHKAssign(\'' + id + '\')">Assign Now</button>'
    );
  };
  window.__confirmHKAssign = async (roomId) => {
    const sel = document.getElementById('hk-staff');
    const staffId = sel ? sel.value : '';
    const staff = state.staff.find(s => s.id === staffId);
    try {
      await API.patch('/api/rooms/' + roomId, { status: 'cleaning' });
      const room = state.rooms.find(r => r.id === roomId);
      if (staff) state.assigned[roomId] = staff;
      toast('Cleaning assigned' + (staff ? ' to ' + staff.name : '') + (room ? ' — Room ' + room.number : ''), 'success');
      closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // Sign-off captures the remark the shift report keeps against the room.
  window.__markRoomClean = (roomId) => {
    const room = state.rooms.find(r => r.id === roomId);
    const hkActive = state.staff.filter(s => s.department === 'Housekeeping' && s.status === 'active');
    const pre = state.assigned[roomId];
    openModal('Room Cleaned — ' + escapeHtml(room ? room.number : ''),
      '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Cleaned By</label><select class="form-select" id="hkc-staff">' +
        '<option value="">— Me (' + escapeHtml(App.user ? App.user.name : 'Operator') + ') —</option>' +
        hkActive.map(s => '<option value="' + s.id + '"' + (pre && pre.id === s.id ? ' selected' : '') + '>' + escapeHtml(s.name) + '</option>').join('') +
      '</select></div>' +
      '<div class="form-group"><label class="form-label">Remark <span style="font-weight:400;color:var(--text3)">(optional — condition, missing items, maintenance needed…)</span></label>' +
        '<textarea class="form-input" id="hkc-remark" rows="3" maxlength="500" placeholder="e.g. Deep-cleaned bathroom, replaced towels; shower head loose — reported to maintenance"></textarea></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
      '<button class="btn primary" onclick="window.__confirmRoomClean(\'' + roomId + '\')">Mark Clean &amp; Available</button>'
    );
  };
  window.__confirmRoomClean = async (roomId) => {
    const staffId = document.getElementById('hkc-staff').value;
    const remark = document.getElementById('hkc-remark').value.trim();
    try {
      await API.post('/api/rooms/' + roomId + '/housekeeping/clean', { staffId: staffId || undefined, remark });
      delete state.assigned[roomId];
      toast('Room marked clean' + (remark ? ' — remark saved' : ''), 'success');
      closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  WSClient.on('room.updated', () => load());
  return wrap;
};
