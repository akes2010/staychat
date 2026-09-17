// public/js/pages/maintenance.js
window.PAGES = window.PAGES || {};

PAGES.maintenance = function () {
  const wrap = el('div', 'fa');
  const state = { reqs: [], staff: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading maintenance…');
    try {
      const [reqs, staff] = await Promise.all([API.get('/api/maintenance'), API.get('/api/staff')]);
      state.reqs = reqs; state.staff = staff;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'maintenance\')'); }
  }

  function render() {
    const countOf = (s) => state.reqs.filter(r => r.status === s).length;
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Maintenance</h1><p>' + countOf('pending') + ' pending &middot; ' + countOf('in-progress') + ' in progress</p></div>' +
      '<button class="btn primary" onclick="window.__openNewMaint()">+ New Request</button></div>' +
    '<div class="grid grid-4" style="margin-bottom:20px">' +
      [['pending','Pending'],['in-progress','In Progress'],['completed','Completed']].map(arr => '<div class="metric-card"><div class="metric-label">' + arr[1] + '</div><div class="metric-value">' + countOf(arr[0]) + '</div></div>').join('') +
      '<div class="metric-card"><div class="metric-label">Total Requests</div><div class="metric-value">' + state.reqs.length + '</div></div>' +
    '</div>' +
    state.reqs.map(req => {
      const borderColor = req.priority === 'high' ? 'var(--error)' : req.priority === 'medium' ? 'var(--warn)' : 'var(--border)';
      let actions = '';
      if (req.status === 'pending') actions += '<button class="btn primary sm" onclick="window.__startMaint(\'' + req.id + '\')">Start Work</button>';
      if (req.status === 'in-progress') actions += '<button class="btn accent sm" onclick="window.__completeMaint(\'' + req.id + '\')">Mark Complete</button>';
      if (req.status !== 'completed') actions += '<button class="btn outline sm" onclick="window.__assignMaint(\'' + req.id + '\')">Assign Staff</button>';
      actions += '<button class="btn ghost sm" onclick="window.__editMaint(\'' + req.id + '\')">Edit</button>';
      return '<div class="card" style="display:flex;gap:14px;margin-bottom:12px;border-left:4px solid ' + borderColor + '">' +
        '<div style="width:48px;height:48px;border-radius:10px;background:' + (req.priority === 'high' ? 'var(--error-bg)' : 'var(--surface2)') + ';display:flex;align-items:center;justify-content:center;font-size:22px;flex-shrink:0">🔧</div>' +
        '<div style="flex:1"><div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">' +
          '<div style="display:flex;align-items:center;gap:9px"><span style="font-weight:700;font-size:15px">Room ' + escapeHtml(req.room_number) + '</span>' + badge(req.priority.toUpperCase(), req.priority === 'high' ? 'error' : req.priority === 'medium' ? 'warn' : 'default') + statusBadge(req.status) + '</div>' +
          '<span style="font-size:11px;color:var(--text3);font-family:var(--font-mono)">' + req.id.slice(0,12) + '</span></div>' +
        '<p style="font-size:13px;margin-bottom:8px">' + escapeHtml(req.issue) + '</p>' +
        '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">' + (req.assignee ? 'Assigned: ' + escapeHtml(req.assignee) : 'Unassigned') + ' &middot; Reported ' + timeAgo(req.created_at) + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + actions + '</div></div></div>';
    }).join('') +
    (state.reqs.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">✅</div><div class="empty-state-title">No maintenance requests</div></div>' : '');
  }

  window.__startMaint = async (id) => { try { await API.patch('/api/maintenance/' + id, { status: 'in-progress' }); toast('Work order started', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } };
  window.__completeMaint = async (id) => { try { await API.patch('/api/maintenance/' + id, { status: 'completed' }); toast('Maintenance completed', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } };
  window.__assignMaint = (id) => {
    const mStaff = state.staff.filter(s => s.department === 'Maintenance' || s.department === 'Front Desk');
    openModal('Assign Maintenance', '<div class="form-group"><label class="form-label">Assign to</label><select class="form-select" id="mnt-staff">' + mStaff.map(s => '<option value="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + ' — ' + escapeHtml(s.role) + '</option>').join('') + '</select></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__confirmMaintAssign(\'' + id + '\')">Assign</button>');
  };
  window.__confirmMaintAssign = async (id) => {
    const sel = document.getElementById('mnt-staff').value;
    try { await API.patch('/api/maintenance/' + id, { assignee: sel, status: 'in-progress' }); toast('Staff assigned', 'success'); closeModal(); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__editMaint = (id) => {
    const req = state.reqs.find(r => r.id === id);
    if (!req) return;
    openModal('Edit Request',
      '<div class="form-row cols-2" style="margin-bottom:14px">' +
        '<div class="form-group"><label class="form-label">Room</label><input class="form-input" id="em-room" value="' + escapeHtml(req.room_number) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Priority</label><select class="form-select" id="em-pri">' + ['high','medium','low'].map(p => '<option value="' + p + '"' + (req.priority === p ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>').join('') + '</select></div></div>' +
      '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Issue Description</label><textarea class="form-textarea" id="em-issue">' + escapeHtml(req.issue) + '</textarea></div>' +
      '<div class="form-group"><label class="form-label">Status</label><select class="form-select" id="em-status">' + ['pending','in-progress','completed'].map(s => '<option value="' + s + '"' + (req.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('') + '</select></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger sm" onclick="window.__deleteMaint(\'' + id + '\')">Delete</button><button class="btn primary" onclick="window.__saveMaint(\'' + id + '\')">Save</button>'
    );
  };
  window.__saveMaint = async (id) => {
    try {
      await API.patch('/api/maintenance/' + id, {
        roomNumber: document.getElementById('em-room').value, issue: document.getElementById('em-issue').value,
        priority: document.getElementById('em-pri').value, status: document.getElementById('em-status').value,
      });
      toast('Request updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteMaint = (id) => {
    confirmAction('Delete this request?', async () => {
      try { await API.del('/api/maintenance/' + id); toast('Request deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__openNewMaint = () => {
    openModal('New Maintenance Request',
      '<div class="form-row cols-2" style="margin-bottom:14px">' +
        '<div class="form-group"><label class="form-label">Room Number</label><input class="form-input" id="nm-room" placeholder="e.g. 205"/></div>' +
        '<div class="form-group"><label class="form-label">Priority</label><select class="form-select" id="nm-pri"><option value="high">High</option><option value="medium" selected>Medium</option><option value="low">Low</option></select></div></div>' +
      '<div class="form-group"><label class="form-label">Issue Description</label><textarea class="form-textarea" id="nm-issue" placeholder="Describe the issue in detail…"></textarea></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitMaint()">Submit Request</button>'
    );
  };
  window.__submitMaint = async () => {
    const roomNumber = document.getElementById('nm-room').value.trim();
    const issue = document.getElementById('nm-issue').value.trim();
    if (!roomNumber || !issue) { toast('Room and issue are required', 'error'); return; }
    try {
      await API.post('/api/maintenance', { roomNumber, issue, priority: document.getElementById('nm-pri').value });
      toast('Maintenance request submitted', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  WSClient.on('maintenance.created', () => load());
  WSClient.on('maintenance.updated', () => load());
  return wrap;
};
