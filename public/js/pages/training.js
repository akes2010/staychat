// public/js/pages/training.js
// Welcome & training tracker — the in-app twin of the one-page checklist PDF.
// Ticks, trainer sign-offs and go-live fields autosave to one tenant-scoped
// JSON document (/api/training). The same page carries the team-invite panel,
// so a new hotel can create staff logins while working through the checklist.
window.PAGES = window.PAGES || {};

PAGES.training = function () {
  const wrap = el('div', 'fa');
  const state = { data: null, users: [], saving: false, timer: null, savedAt: null };

  const SETUP = [
    ['owner', 'Owner account live', 'Signed in at /app with your own login; password changed from the welcome email.'],
    ['rooms', 'Rooms and rates', 'Every sellable room has a number, type and price; the room strip shows the right count.'],
    ['staff', 'Staff accounts', 'One login per person, with the right role — invite them from this page.'],
    ['whatsapp', 'WhatsApp connected', 'One test thread sent and answered from the Inbox.'],
    ['payments', 'Payments', 'Cash and card methods on; gateway connected and one test payment taken if you charge online.'],
    ['booking', 'Booking page', 'Your public link opens on a phone; make a test booking and cancel it.'],
    ['print', 'Print the pack', 'Cheat sheet per station, a manual per department and this checklist per trainee.'],
  ];
  const ORIENTATION = [
    ['tour', 'Dashboard tour', 'Occupancy, arrivals today and the pending badges they must clear before shift end.'],
    ['offline', 'The offline rule', 'Keep working offline; never write the same booking or payment twice on paper.'],
    ['path', 'Hand out the role path', 'Agree shift 1 watch, shift 2 do, shift 3 own — and book the sign-off slot.'],
    ['help', 'Show where help lives', 'Sidebar → Help & training, the printed manual chapter for their role, and this tracker.'],
  ];
  const REVIEW = [
    ['owners', 'Every role has a signed-off owner for each shift', ''],
    ['drill', 'One drill per role re-run; note who needs a refresher (manual ch. 80)', ''],
    ['eod', 'End of Day closes on time and variances are explained, not edited', ''],
  ];
  const ROLE_PATHS = [
    { key: 'reception', name: 'Receptionist', shifts: '3 shifts', chapters: '01, 03–05, 07, 08, 23',
      criteria: 'Check in and out with a $0 balance · move a room · answer WhatsApp and create the right record' },
    { key: 'fnb', name: 'Food & beverage', shifts: '3 shifts', chapters: '10–14, 25, 30',
      criteria: 'Open and settle a restaurant ticket · run a bar tab to a room charge · split a bill · close the department' },
    { key: 'housekeeping', name: 'Housekeeping', shifts: '2 shifts + assessment', chapters: '03, 18–20, 27',
      criteria: 'Assign, clean and release a floor · raise a repair with detail · report lost property · clock in and out' },
    { key: 'accounts', name: 'Accounts', shifts: '3 days', chapters: '21–25, 02, 32',
      criteria: 'Produce the day pack in 30 min · balance the journal and cash book · document a variance · refund with reason' },
  ];
  const INVITE_ROLES = [
    ['receptionist', 'Receptionist'], ['server', 'Server (restaurant)'], ['cashier', 'Cashier'],
    ['barman', 'Barman (bar)'], ['waiter', 'Waiter'], ['staff', 'Housekeeping / general staff'], ['accountant', 'Accountant'],
  ];
  const ROLE_LABELS = {
    hotel_admin: 'Hotel Admin', receptionist: 'Receptionist', staff: 'Staff', cashier: 'Cashier',
    barman: 'Barman', waiter: 'Waiter', server: 'Server', porter: 'Porter', accountant: 'Accountant', auditor: 'Auditor',
  };

  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    const out = { trainer: d.trainer || '', goLiveDate: d.goLiveDate || '', setup: {}, orientation: {}, roles: {}, goLive: {}, review: {} };
    SETUP.forEach(([k]) => { out.setup[k] = !!d.setup[k]; });
    ORIENTATION.forEach(([k]) => { out.orientation[k] = !!d.orientation[k]; });
    REVIEW.forEach(([k]) => { out.review[k] = !!d.review[k]; });
    ROLE_PATHS.forEach(r => {
      const x = (d.roles && d.roles[r.key]) || {};
      out.roles[r.key] = { done: !!x.done, trainer: x.trainer || '', date: x.date || '', notes: x.notes || '' };
    });
    const g = d.goLive || {};
    out.goLive = { trainee: g.trainee || '', role: g.role || '', trainer: g.trainer || '', date: g.date || '' };
    return out;
  }

  async function load() {
    wrap.innerHTML = loaderHTML('Loading your training checklist…');
    try {
      const [res, users] = await Promise.all([API.get('/api/training'), API.get('/api/users')]);
      state.data = normalize(res.data);
      state.users = Array.isArray(users) ? users : [];
      state.savedAt = res.updatedAt;
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, "navigate('training')");
    }
  }

  function progress() {
    let done = 0;
    const total = SETUP.length + ORIENTATION.length + REVIEW.length + ROLE_PATHS.length;
    SETUP.forEach(([k]) => { if (state.data.setup[k]) done++; });
    ORIENTATION.forEach(([k]) => { if (state.data.orientation[k]) done++; });
    REVIEW.forEach(([k]) => { if (state.data.review[k]) done++; });
    ROLE_PATHS.forEach(r => { if (state.data.roles[r.key].done) done++; });
    return { done, total, pct: Math.round(done / total * 100) };
  }

  function checkRow(scope, key, label, hint) {
    const on = !!state.data[scope][key];
    return '<label class="tcheck" style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">' +
      '<input type="checkbox" data-check="' + scope + ':' + key + '"' + (on ? ' checked' : '') + ' style="margin-top:3px;width:16px;height:16px;accent-color:var(--p);flex-shrink:0"/>' +
      '<span><span class="tlabel" style="font-weight:600;font-size:13px">' + escapeHtml(label) + '</span>' +
      (hint ? '<span style="display:block;font-size:12px;color:var(--text3);line-height:1.45;margin-top:2px">' + escapeHtml(hint) + '</span>' : '') +
      '</span></label>';
  }

  function roleCard(r) {
    const x = state.data.roles[r.key];
    return '<div class="card" style="padding:16px;margin-bottom:12px">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
        '<div><div style="font-weight:700;font-size:14px">' + escapeHtml(r.name) + '</div>' +
          '<div style="font-size:11.5px;color:var(--text3);margin-top:2px">' + escapeHtml(r.shifts) + ' · chapters ' + escapeHtml(r.chapters) + '</div></div>' +
        '<label style="display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:' + (x.done ? 'var(--p)' : 'var(--text3)') + ';cursor:pointer">' +
          '<input type="checkbox" data-role-done="' + r.key + '"' + (x.done ? ' checked' : '') + ' style="width:16px;height:16px;accent-color:var(--p)"/> Signed off</label>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text3);line-height:1.5;margin:8px 0 10px">' + escapeHtml(r.criteria) + '</div>' +
      '<div class="form-row cols-2">' +
        '<div class="form-group" style="margin:0"><label class="form-label">Trainer</label>' +
          '<input class="form-input" data-role-field="trainer" data-role="' + r.key + '" value="' + escapeHtml(x.trainer) + '" placeholder="Who signed them off?"/></div>' +
        '<div class="form-group" style="margin:0"><label class="form-label">Date signed</label>' +
          '<input class="form-input" type="date" data-role-field="date" data-role="' + r.key + '" value="' + escapeHtml(x.date) + '"/></div>' +
      '</div>' +
      '<div class="form-group" style="margin:8px 0 0"><label class="form-label">Notes</label>' +
        '<input class="form-input" data-role-field="notes" data-role="' + r.key + '" value="' + escapeHtml(x.notes) + '" placeholder="Refresher needed on…"/></div>' +
      '</div>';
  }

  function teamRows() {
    const active = state.users.filter(u => u.active);
    if (!active.length) return '<div style="font-size:12px;color:var(--text3);padding:8px 0">No staff logins yet — invite the first one above.</div>';
    return active.map(u => '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">' +
      '<div style="display:flex;align-items:center;gap:9px;min-width:0">' +
        '<div style="width:28px;height:28px;border-radius:99px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--p);flex-shrink:0">' + escapeHtml(u.avatar || u.name.slice(0, 2).toUpperCase()) + '</div>' +
        '<div style="min-width:0"><div style="font-size:12.5px;font-weight:600">' + escapeHtml(u.name) + (App.user && u.id === App.user.id ? ' <span style="font-weight:400;color:var(--text3)">(you)</span>' : '') + '</div>' +
          '<div style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis">' + escapeHtml(u.email) + '</div></div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' + badge(ROLE_LABELS[u.role] || u.role, 'info') +
        (u.department ? '<div style="font-size:10.5px;color:var(--text3);margin-top:2px">' + escapeHtml(u.department) + '</div>' : '') + '</div>' +
    '</div>').join('');
  }

  function render() {
    const pr = progress();
    const u = App.user || {};
    wrap.innerHTML =
      '<style>.tcheck input:checked + span .tlabel{color:var(--text3);text-decoration:line-through}</style>' +
      '<div class="page-header"><div class="page-header-left"><h1>Welcome &amp; Training Checklist</h1>' +
        '<p>Work through setup and sign off each role — saved automatically for this hotel.</p></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
          '<a class="btn outline" href="/StayChat-OS-Welcome-Checklist.pdf" target="_blank" rel="noopener">🖨 Print version</a>' +
          '<a class="btn primary" href="/StayChat-OS-Onboarding-Pack.zip" download>↓ Pack (ZIP)</a>' +
        '</div></div>' +

      '<div class="card" style="margin-bottom:16px">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
          '<div><div style="font-weight:700;font-size:15px" id="training-progress-title">' + pr.done + ' of ' + pr.total + ' steps done</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-top:2px" id="training-save-status">' +
              (state.savedAt ? 'Last saved ' + escapeHtml(String(state.savedAt).replace('T', ' ').replace('Z', '') + ' UTC') : 'Not saved yet') + '</div></div>' +
          '<div style="font-size:26px;font-weight:800;color:var(--p)" id="training-progress-pct">' + pr.pct + '%</div>' +
        '</div>' +
        '<div style="height:8px;background:var(--surface2);border-radius:99px;margin-top:10px;overflow:hidden">' +
          '<div id="training-progress-bar" style="height:100%;width:' + pr.pct + '%;background:var(--p);border-radius:99px;transition:width .25s"></div></div>' +

        '<div class="form-row cols-3" style="margin-top:16px">' +
          '<div class="form-group" style="margin:0"><label class="form-label">Hotel</label>' +
            '<input class="form-input" value="' + escapeHtml((App.tenant && App.tenant.name) || '') + '" disabled/></div>' +
          '<div class="form-group" style="margin:0"><label class="form-label">Manager / trainer</label>' +
            '<input class="form-input" data-field="trainer" value="' + escapeHtml(state.data.trainer) + '" placeholder="' + escapeHtml(u.name || 'Your name') + '"/></div>' +
          '<div class="form-group" style="margin:0"><label class="form-label">Go-live date</label>' +
            '<input class="form-input" type="date" data-field="goLiveDate" value="' + escapeHtml(state.data.goLiveDate) + '"/></div>' +
        '</div>' +
      '</div>' +

      '<div class="grid grid-2">' +
        '<div>' +
          '<div class="card" style="margin-bottom:16px"><div style="font-weight:700;font-size:15px;margin-bottom:2px">Before day one</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">Setup · 30–60 minutes</div>' +
            SETUP.map(([k, l, h]) => checkRow('setup', k, l, h)).join('') + '</div>' +

          '<div class="card" style="margin-bottom:16px"><div style="font-weight:700;font-size:15px;margin-bottom:2px">First 30 minutes with the team</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">Orientation</div>' +
            ORIENTATION.map(([k, l, h]) => checkRow('orientation', k, l, h)).join('') + '</div>' +

          '<div style="background:var(--surface2);border-left:4px solid var(--p);border-radius:8px;padding:12px 14px;font-size:12.5px;line-height:1.55">' +
            '<b>Give every new hire three things:</b> the manual chapters for their path, the printed cheat sheet for their station, and a named trainer for the first three shifts. Reading first, clicking second.</div>' +
        '</div>' +

        '<div>' +
          '<div class="card" style="margin-bottom:16px"><div style="font-weight:700;font-size:15px;margin-bottom:2px">Week one by role</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Sign off only when they can do it alone, at full speed.</div>' +
            ROLE_PATHS.map(roleCard).join('') + '</div>' +

          '<div class="card" style="margin-bottom:16px"><div style="font-weight:700;font-size:15px;margin-bottom:2px">Go-live sign-off</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Done on the live system, unaided — not just watched.</div>' +
            '<div class="form-row cols-2">' +
              '<div class="form-group" style="margin:0"><label class="form-label">Trainee name</label>' +
                '<input class="form-input" data-golive-field="trainee" value="' + escapeHtml(state.data.goLive.trainee) + '"/></div>' +
              '<div class="form-group" style="margin:0"><label class="form-label">Role</label>' +
                '<input class="form-input" data-golive-field="role" value="' + escapeHtml(state.data.goLive.role) + '"/></div>' +
              '<div class="form-group" style="margin:0"><label class="form-label">Trainer name</label>' +
                '<input class="form-input" data-golive-field="trainer" value="' + escapeHtml(state.data.goLive.trainer) + '"/></div>' +
              '<div class="form-group" style="margin:0"><label class="form-label">Date signed</label>' +
                '<input class="form-input" type="date" data-golive-field="date" value="' + escapeHtml(state.data.goLive.date) + '"/></div>' +
            '</div></div>' +

          '<div class="card"><div style="font-weight:700;font-size:15px;margin-bottom:2px">Two-week review</div>' +
            '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">Manager</div>' +
            REVIEW.map(([k, l, h]) => checkRow('review', k, l, h)).join('') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="card" style="margin-top:16px">' +
        '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:4px">' +
          '<div><div style="font-weight:700;font-size:15px">Invite your team</div>' +
            '<div style="font-size:12px;color:var(--text3)">Create one login per person — the checklist step nobody should skip.</div></div>' +
          '<div style="font-size:12px;color:var(--text3)"><b id="team-count">' + state.users.filter(x => x.active).length + '</b> active staff logins</div>' +
        '</div>' +
        '<div class="form-row cols-2" style="margin-top:12px">' +
          '<div class="form-group" style="margin:0"><label class="form-label">Full name</label>' +
            '<input class="form-input" id="inv-name" placeholder="Jane Doe"/></div>' +
          '<div class="form-group" style="margin:0"><label class="form-label">Email</label>' +
            '<input class="form-input" type="email" id="inv-email" placeholder="jane@hotel.com"/></div>' +
          '<div class="form-group" style="margin:0"><label class="form-label">Role</label>' +
            '<select class="form-input" id="inv-role">' + INVITE_ROLES.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('') + '</select></div>' +
          '<div class="form-group" style="margin:0"><label class="form-label">Department <span style="font-weight:400;color:var(--text3)">(optional)</span></label>' +
            '<input class="form-input" id="inv-dept" placeholder="e.g. Front Desk"/></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap">' +
          '<button class="btn primary" id="inv-btn" onclick="window.__trainingInvite()">+ Create staff login</button>' +
          '<span style="font-size:11.5px;color:var(--text3)">A temporary password is generated — you share it once, they change it after signing in.</span>' +
        '</div>' +
        '<div id="inv-credentials" style="display:none;margin-top:14px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px">' +
          '<div style="font-weight:700;font-size:13px;margin-bottom:6px">Account created — share these credentials</div>' +
          '<div style="font-size:12.5px;line-height:1.8">Email: <b id="inv-cred-email"></b><br>Temporary password: <b id="inv-cred-pass" style="font-family:ui-monospace,monospace;letter-spacing:.5px"></b><br>' +
            '<span style="color:var(--text3)">Sign in at ' + escapeHtml(location.origin) + '/app</span></div>' +
          '<button class="btn outline sm" style="margin-top:10px" onclick="window.__trainingCopyInvite()">Copy credentials</button>' +
        '</div>' +
        '<div id="team-list" style="margin-top:14px">' + teamRows() + '</div>' +
      '</div>';

    bind();
  }

  function setStatus(text, error) {
    const s = document.getElementById('training-save-status');
    if (s) { s.textContent = text; s.style.color = error ? 'var(--error)' : 'var(--text3)'; }
  }

  function updateProgress() {
    const pr = progress();
    const bar = document.getElementById('training-progress-bar');
    if (bar) bar.style.width = pr.pct + '%';
    const title = document.getElementById('training-progress-title');
    if (title) title.textContent = pr.done + ' of ' + pr.total + ' steps done';
    const pct = document.getElementById('training-progress-pct');
    if (pct) pct.textContent = pr.pct + '%';
  }

  function scheduleSave() {
    setStatus('Saving…');
    clearTimeout(state.timer);
    state.timer = setTimeout(save, 700);
  }

  async function save() {
    if (state.saving) { scheduleSave(); return; }
    state.saving = true;
    try {
      const res = await API.put('/api/training', { data: state.data });
      state.savedAt = res.updatedAt;
      const d = new Date();
      setStatus('Saved at ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    } catch (err) {
      setStatus('Not saved — ' + err.message, true);
    } finally {
      state.saving = false;
    }
  }

  function bind() {
    wrap.addEventListener('change', e => {
      const t = e.target;
      if (t.matches('[data-check]')) {
        const [scope, key] = t.dataset.check.split(':');
        state.data[scope][key] = t.checked;
        updateProgress(); scheduleSave();
      } else if (t.matches('[data-role-done]')) {
        state.data.roles[t.dataset.roleDone].done = t.checked;
        updateProgress(); scheduleSave();
      } else if (t.matches('[data-field]')) {
        state.data[t.dataset.field] = t.value;
        scheduleSave();
      } else if (t.matches('[data-role-field]')) {
        state.data.roles[t.dataset.role][t.dataset.roleField] = t.value;
        scheduleSave();
      } else if (t.matches('[data-golive-field]')) {
        state.data.goLive[t.dataset.goliveField] = t.value;
        scheduleSave();
      }
    });
    wrap.addEventListener('input', e => {
      const t = e.target;
      if (t.matches('input[data-field]')) {
        state.data[t.dataset.field] = t.value;
        scheduleSave();
      } else if (t.matches('input[data-role-field]')) {
        state.data.roles[t.dataset.role][t.dataset.roleField] = t.value;
        scheduleSave();
      } else if (t.matches('input[data-golive-field]')) {
        state.data.goLive[t.dataset.goliveField] = t.value;
        scheduleSave();
      }
    });
  }

  function tempPassword() {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnopqrstuvwxyz';
    const digits = '23456789', symbols = '!@#$%&*';
    const all = upper + lower + digits + symbols;
    const pick = s => {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return s[a[0] % s.length];
    };
    const out = [pick(upper), pick(lower), pick(digits), pick(symbols)];
    while (out.length < 12) out.push(pick(all));
    for (let i = out.length - 1; i > 0; i--) {
      const a = new Uint32Array(1); crypto.getRandomValues(a);
      const j = a[0] % (i + 1);
      const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out.join('');
  }

  window.__trainingInvite = async () => {
    const name = document.getElementById('inv-name').value.trim();
    const email = document.getElementById('inv-email').value.trim();
    const role = document.getElementById('inv-role').value;
    const department = document.getElementById('inv-dept').value.trim();
    if (!name || !email) { toast('Name and email are required', 'error'); return; }
    const btn = document.getElementById('inv-btn');
    btn.disabled = true;
    try {
      const password = tempPassword();
      await API.post('/api/users', { name, email, password, role, department });
      document.getElementById('inv-cred-email').textContent = email;
      document.getElementById('inv-cred-pass').textContent = password;
      document.getElementById('inv-credentials').style.display = '';
      document.getElementById('inv-name').value = '';
      document.getElementById('inv-email').value = '';
      document.getElementById('inv-dept').value = '';
      state.users = await API.get('/api/users');
      document.getElementById('team-list').innerHTML = teamRows();
      document.getElementById('team-count').textContent = state.users.filter(x => x.active).length;
      toast('Staff login created — share the temporary password', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  window.__trainingCopyInvite = async () => {
    const email = document.getElementById('inv-cred-email').textContent;
    const password = document.getElementById('inv-cred-pass').textContent;
    const text = 'StayChat OS — staff login\nSign in: ' + location.origin + '/app\nEmail: ' + email +
      '\nTemporary password: ' + password + '\nChange the password after your first sign-in.';
    try {
      await navigator.clipboard.writeText(text);
      toast('Credentials copied', 'success');
    } catch (err) {
      toast('Could not copy — select the details manually', 'error');
    }
  };

  load();
  return wrap;
};
