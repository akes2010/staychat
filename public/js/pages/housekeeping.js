// public/js/pages/housekeeping.js
window.PAGES = window.PAGES || {};

PAGES.housekeeping = function () {
  const wrap = el('div', 'fa');
  const state = { rooms: [], staff: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading housekeeping…');
    try {
      const [rooms, staff] = await Promise.all([API.get('/api/rooms'), API.get('/api/staff')]);
      state.rooms = rooms; state.staff = staff;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'housekeeping\')'); }
  }

  function render() {
    const dirty = state.rooms.filter(r => r.status === 'dirty');
    const cleaning = state.rooms.filter(r => r.status === 'cleaning');
    const available = state.rooms.filter(r => r.status === 'available');
    const hkStaff = state.staff.filter(s => s.department === 'Housekeeping');

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Housekeeping</h1><p>' + dirty.length + ' dirty &middot; ' + cleaning.length + ' in progress &middot; ' + available.length + ' clean &amp; ready</p></div></div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      '<div class="metric-card"><div class="metric-top"><div class="metric-icon" style="background:#fef2f2">🚨</div></div><div class="metric-label">Needs Cleaning</div><div class="metric-value">' + dirty.length + '</div></div>' +
      '<div class="metric-card"><div class="metric-top"><div class="metric-icon" style="background:#eff6ff">🔄</div></div><div class="metric-label">In Progress</div><div class="metric-value">' + cleaning.length + '</div></div>' +
      '<div class="metric-card"><div class="metric-top"><div class="metric-icon" style="background:#f0fdf4">✅</div></div><div class="metric-label">Cleaned Today</div><div class="metric-value">' + available.length + '</div></div>' +
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
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(room.type) + '</div><div style="font-size:11px;color:var(--text3)">In progress</div></div>' +
          '<button class="btn primary sm" onclick="window.__markRoomClean(\'' + room.id + '\')">Clean</button></div>').join('') +
      '</div>' +
    '</div>' +
    '<div class="card"><div class="card-header"><span class="card-title">Staff Performance Today</span></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">' +
        (hkStaff.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No housekeeping staff added yet</div>' : '') +
        hkStaff.map(s => '<div style="background:var(--surface2);border-radius:var(--radius);padding:14px;border:1px solid var(--border)">' +
          '<div style="font-weight:600;font-size:13px;margin-bottom:3px">' + escapeHtml(s.name) + '</div><div style="font-size:11px;color:var(--text3);margin-bottom:10px">' + escapeHtml(s.role) + ' &middot; ' + escapeHtml(s.shift) + '</div>' +
          '<div style="font-size:12px;color:var(--p);font-weight:700;margin-bottom:7px">' + s.tasks_completed + ' tasks &middot; Avg ' + escapeHtml(s.avg_time) + '</div>' + pbar(Math.min(100, s.tasks_completed * 3), 'var(--a)') + '</div>').join('') +
      '</div></div>';
  }

  window.__assignHKRoom = (id) => {
    const hkActive = state.staff.filter(s => s.department === 'Housekeeping' && s.status === 'active');
    openModal('Assign Cleaning',
      '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Assign To</label><select class="form-select" id="hk-staff">' + hkActive.map(s => '<option value="' + s.id + '">' + escapeHtml(s.name) + ' (' + s.tasks_completed + ' done today)</option>').join('') + '</select></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn accent" onclick="window.__confirmHKAssign(\'' + id + '\')">Assign Now</button>'
    );
  };
  window.__confirmHKAssign = async (roomId) => {
    try { await API.patch('/api/rooms/' + roomId, { status: 'cleaning' }); toast('Cleaning assigned via WhatsApp', 'success'); closeModal(); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__markRoomClean = async (roomId) => {
    try { await API.patch('/api/rooms/' + roomId, { status: 'available' }); toast('Room marked clean & available', 'success'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  load();
  WSClient.on('room.updated', () => load());
  return wrap;
};
