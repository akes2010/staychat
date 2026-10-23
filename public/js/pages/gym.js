// public/js/pages/gym.js
// Gym Management & Booking — fitness-centre inventory (gyms with name, type,
// facilities, capacity and daily/monthly/quarterly/yearly registration prices)
// plus member registrations (memberships) with per-gym capacity enforcement.
window.PAGES = window.PAGES || {};

PAGES.gym = function () {
  const wrap = el('div', 'fa');
  const state = { gyms: [], registrations: [], view: 'upcoming' };
  const canManageGym = typeof can === 'function' ? can('gym.manage') : true;

  const GYM_TYPES = ['Standard', 'Premium', 'Yoga & Wellness', 'CrossFit', 'Cardio Studio', 'Spa & Gym'];
  const FACILITY_OPTIONS = ['Free Weights', 'Cardio Machines', 'Strength Machines', 'Sauna', 'Steam Room', 'Showers', 'Lockers', 'Personal Trainer', 'Group Classes', 'Swimming Pool', 'Towel Service', 'Wi-Fi'];
  const REG_LABELS = { daily: 'Daily Pass', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading gym & fitness…');
    try {
      const [gyms, registrations] = await Promise.all([API.get('/api/gym/gyms'), API.get('/api/gym/registrations')]);
      state.gyms = gyms; state.registrations = registrations;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'gym\')'); }
  }

  function statusColor(s) { return { active: 'success', completed: 'default', cancelled: 'error' }[s] || 'default'; }
  function statusBadge2(s) { return badge(s.charAt(0).toUpperCase() + s.slice(1), statusColor(s)); }
  function fmtDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }
  function fmtPeriod(b) { return b.start_date === b.end_date ? fmtDate(b.start_date) : fmtDate(b.start_date) + ' – ' + fmtDate(b.end_date); }

  function render() {
    const today = new Date().toISOString().slice(0, 10);
    let list = state.registrations.slice();
    if (state.view === 'upcoming') list = list.filter(b => b.end_date >= today && b.status === 'active');
    else if (state.view !== 'all') list = list.filter(b => b.status === state.view);
    list.sort((a, b) => (b.start_date).localeCompare(a.start_date));

    const activeCount = state.registrations.filter(b => b.status === 'active').length;

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Gym &amp; Fitness</h1><p>' + state.gyms.length + ' gym' + (state.gyms.length === 1 ? '' : 's') + ' &middot; ' + activeCount + ' active registration' + (activeCount === 1 ? '' : 's') + '</p></div>' +
      '<div style="display:flex;gap:10px">' +
        (canManageGym ? '<button class="btn outline" onclick="window.__manageGyms()">Manage Gyms</button>' : '') +
        '<button class="btn primary" onclick="window.__openNewGymRegistration()">+ New Registration</button>' +
      '</div></div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      state.gyms.slice(0, 3).map(g => metricCard(g.name, g.capacity + ' cap', formatMoney(g.price_daily) + '/day', '🏋️')).join('') +
    '</div>' +
    (state.gyms.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🏋️</div><div class="empty-state-title">No gyms set up yet</div><div class="empty-state-desc">Add a gym to start taking registrations.</div>' + (canManageGym ? '<button class="btn primary" style="margin-top:12px" onclick="window.__manageGyms()">Add a Gym</button>' : '') + '</div>' :
    '<div class="filter-pills" style="margin-bottom:16px">' +
      ['upcoming', 'active', 'completed', 'cancelled', 'all'].map(f =>
        '<button class="pill ' + (state.view === f ? 'active' : '') + '" onclick="window.__gymView(\'' + f + '\')">' + f.charAt(0).toUpperCase() + f.slice(1) + '</button>'
      ).join('') +
    '</div>' +
    (list.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No registrations here</div></div>' :
    '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(b => {
      const gym = state.gyms.find(g => g.id === b.gym_id);
      return '<div class="card" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 18px">' +
        '<div style="flex:1;min-width:200px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px"><span style="font-weight:700;font-size:14px">' + escapeHtml(b.member_name) + '</span>' + badge(REG_LABELS[b.registration_type] || b.registration_type, 'info') + statusBadge2(b.status) + (b.paid ? badge('Paid', 'success') : badge('Unpaid', 'warn')) + '</div>' +
          '<div style="font-size:12px;color:var(--text3)">' + escapeHtml(gym ? gym.name : 'Unknown Gym') + (b.member_phone ? ' &middot; ' + escapeHtml(b.member_phone) : '') + (b.room_number ? ' &middot; Room ' + escapeHtml(b.room_number) : '') + '</div>' +
        '</div>' +
        '<div style="text-align:center;min-width:220px"><div style="font-size:12px;font-weight:600">' + fmtPeriod(b) + '</div><div style="font-size:11px;color:var(--text3)">' + (b.start_date === b.end_date ? 'One-day pass' : 'Membership period') + '</div></div>' +
        '<div style="text-align:right;min-width:90px"><div style="font-weight:800;color:var(--p)">' + formatMoney(b.amount) + '</div></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn ghost sm" onclick="window.__viewGymRegistration(\'' + b.id + '\')">View</button>' +
          (b.status === 'active' ? '<button class="btn ghost sm" onclick="window.__editGymRegistration(\'' + b.id + '\')">Edit</button>' : '') +
          (b.status === 'active' ? '<button class="btn outline sm" onclick="window.__gymRegistrationAction(\'' + b.id + '\',\'complete\')">Complete</button>' : '') +
          (b.status === 'active' && canManageGym ? '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__gymRegistrationAction(\'' + b.id + '\',\'cancel\')">Cancel</button>' : '') +
        '</div>' +
      '</div>';
    }).join('') + '</div>'));
  }

  window.__gymView = (v) => { state.view = v; render(); };

  window.__gymRegistrationAction = async (id, action) => {
    try { await API.post('/api/gym/registrations/' + id + '/' + action); toast('Updated', 'success'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__viewGymRegistration = (id) => {
    const b = state.registrations.find(x => x.id === id);
    if (!b) return;
    const gym = state.gyms.find(g => g.id === b.gym_id);
    openModal('🏋️ ' + escapeHtml(b.member_name),
      '<div style="display:flex;flex-direction:column;gap:10px;font-size:13px">' +
        '<div><strong>Gym:</strong> ' + escapeHtml(gym ? gym.name : '—') + '</div>' +
        '<div><strong>Status:</strong> ' + statusBadge2(b.status) + ' &nbsp; <strong>Payment:</strong> ' + (b.paid ? badge('Paid', 'success') : badge('Unpaid', 'warn')) + '</div>' +
        '<div><strong>Registration:</strong> ' + badge(REG_LABELS[b.registration_type] || b.registration_type, 'info') + '</div>' +
        '<div><strong>Member:</strong> ' + escapeHtml(b.member_name) + (b.member_phone ? ' · ' + escapeHtml(b.member_phone) : '') + (b.member_email ? ' · ' + escapeHtml(b.member_email) : '') + (b.room_number ? ' · Room ' + escapeHtml(b.room_number) : '') + '</div>' +
        '<div><strong>Period:</strong> ' + fmtPeriod(b) + '</div>' +
        (gym && gym.facilities && gym.facilities.length ? '<div><strong>Facilities:</strong> ' + gym.facilities.map(f => escapeHtml(f)).join(', ') + '</div>' : '') +
        '<div><strong>Amount:</strong> ' + formatMoney(b.amount) + '</div>' +
        (b.notes ? '<div><strong>Notes:</strong> ' + escapeHtml(b.notes) + '</div>' : '') +
        '<div style="font-size:11px;color:var(--text3)">Registered by ' + escapeHtml(b.created_by || '—') + '</div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>'
    );
  };

  // ── New registration ─────────────────────────────────────────────────
  window.__openNewGymRegistration = () => {
    const activeGyms = state.gyms.filter(g => g.active);
    if (activeGyms.length === 0) { toast('Add a gym first', 'error'); return; }
    openModal('New Gym Registration',
      '<div class="form-row cols-2">' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">Gym</label><select class="form-select" id="gr-gym" onchange="window.__gymPicked()">' + activeGyms.map(g => '<option value="' + g.id + '" data-price-daily="' + g.price_daily + '" data-price-monthly="' + g.price_monthly + '" data-price-quarterly="' + g.price_quarterly + '" data-price-yearly="' + g.price_yearly + '" data-facilities="' + escapeHtml(JSON.stringify(g.facilities || [])) + '">' + escapeHtml(g.name) + ' (cap ' + g.capacity + ')</option>').join('') + '</select>' +
          '<div id="gr-facilities" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px"></div></div>' +
        '<div class="form-group"><label class="form-label">Member Name</label><input class="form-input" id="gr-name" placeholder="Full name"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="gr-phone" placeholder="+234…"/></div>' +
        '<div class="form-group"><label class="form-label">Email (optional)</label><input class="form-input" type="email" id="gr-email" placeholder="member@email.com"/></div>' +
        '<div class="form-group"><label class="form-label">Room Number (optional)</label><input class="form-input" id="gr-room" placeholder="e.g. 204"/></div>' +
        '<div class="form-group"><label class="form-label">Registration Type</label><select class="form-select" id="gr-type" onchange="window.__gymPicked()"><option value="daily">Daily Pass</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select></div>' +
        '<div class="form-group"><label class="form-label">Start Date</label><input class="form-input" type="date" id="gr-start" value="' + new Date().toISOString().slice(0, 10) + '"/></div>' +
        (canManageGym ? '<div class="form-group"><label class="form-label">Amount ($)</label><input class="form-input" type="number" min="0" id="gr-amount" value="0"/></div>' : '') +
        (canManageGym ? '<div class="form-group"><label class="form-label">Paid</label><select class="form-select" id="gr-paid"><option value="false">No</option><option value="true">Yes</option></select></div>' : '') +
      '</div>' +
      '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="gr-notes" placeholder="Optional notes…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitGymRegistration()">Register Member</button>',
      { wide: true }
    );
    window.__gymPicked();
  };
  window.__gymPicked = () => {
    const sel = document.getElementById('gr-gym');
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    const type = document.getElementById('gr-type').value;
    const amountEl = document.getElementById('gr-amount');
    if (amountEl) amountEl.value = opt.dataset['price' + type.charAt(0).toUpperCase() + type.slice(1)] || 0;
    const facEl = document.getElementById('gr-facilities');
    let facilities = [];
    try { facilities = JSON.parse(opt.dataset.facilities || '[]'); } catch (e) { facilities = []; }
    if (facEl) facEl.innerHTML = facilities.length ? facilities.map(f => badge(f, 'default')).join('') : '<span style="font-size:11px;color:var(--text3)">No facilities listed for this gym</span>';
  };
  window.__submitGymRegistration = async () => {
    const memberName = document.getElementById('gr-name').value.trim();
    const startDate = document.getElementById('gr-start').value;
    if (!memberName) { toast('Member name is required', 'error'); return; }
    if (!startDate) { toast('Start date is required', 'error'); return; }
    const amountEl = document.getElementById('gr-amount');
    const paidEl = document.getElementById('gr-paid');
    try {
      await API.post('/api/gym/registrations', {
        gymId: document.getElementById('gr-gym').value, memberName,
        memberPhone: document.getElementById('gr-phone').value.trim(),
        memberEmail: document.getElementById('gr-email').value.trim() || null,
        roomNumber: document.getElementById('gr-room').value.trim() || null,
        registrationType: document.getElementById('gr-type').value, startDate,
        amount: amountEl ? Number(amountEl.value || 0) : undefined,
        paid: paidEl ? paidEl.value === 'true' : undefined,
        notes: document.getElementById('gr-notes').value,
      });
      toast('Member registered', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Edit registration ────────────────────────────────────────────────
  window.__editGymRegistration = (id) => {
    const b = state.registrations.find(x => x.id === id);
    if (!b) return;
    openModal('Edit Registration',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Member Name</label><input class="form-input" id="eg-name" value="' + escapeHtml(b.member_name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="eg-phone" value="' + escapeHtml(b.member_phone || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="eg-email" value="' + escapeHtml(b.member_email || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Room Number</label><input class="form-input" id="eg-room" value="' + escapeHtml(b.room_number || '') + '"/></div>' +
        (canManageGym ? '<div class="form-group"><label class="form-label">Amount ($)</label><input class="form-input" type="number" min="0" id="eg-amount" value="' + b.amount + '"/></div>' : '') +
        (canManageGym ? '<div class="form-group"><label class="form-label">Paid</label><select class="form-select" id="eg-paid"><option value="true"' + (b.paid ? ' selected' : '') + '>Yes</option><option value="false"' + (!b.paid ? ' selected' : '') + '>No</option></select></div>' : '') +
      '</div>' +
      '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="eg-notes" value="' + escapeHtml(b.notes || '') + '"/></div>' +
      '<p style="font-size:11.5px;color:var(--text3)">To move the membership dates or switch Daily/Monthly/Quarterly/Yearly, cancel this registration and create a new one — pricing and capacity are re-verified on every change.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveGymRegistration(\'' + id + '\')">Save</button>'
    );
  };
  window.__saveGymRegistration = async (id) => {
    const amountEl = document.getElementById('eg-amount');
    const paidEl = document.getElementById('eg-paid');
    try {
      await API.patch('/api/gym/registrations/' + id, {
        memberName: document.getElementById('eg-name').value.trim(),
        memberPhone: document.getElementById('eg-phone').value.trim() || null,
        memberEmail: document.getElementById('eg-email').value.trim() || null,
        roomNumber: document.getElementById('eg-room').value.trim() || null,
        amount: amountEl ? Number(amountEl.value || 0) : undefined,
        paid: paidEl ? paidEl.value === 'true' : undefined,
        notes: document.getElementById('eg-notes').value,
      });
      toast('Registration updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Manage gyms (inventory) ──────────────────────────────────────────
  window.__manageGyms = () => {
    openModal('Manage Gyms',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.gyms.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No gyms yet — add one below.</div>' :
        state.gyms.map(g => '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(g.name) + ' ' + badge(g.type || 'Standard', 'default') + '</div>' +
          (g.description ? '<div style="font-size:11px;color:var(--text3);margin:2px 0">' + escapeHtml(g.description) + '</div>' : '') +
          '<div style="font-size:11px;color:var(--text3);margin:2px 0">' + (g.facilities || []).map(f => escapeHtml(f)).join(' · ') + '</div>' +
          '<div style="font-size:11px;color:var(--text3)">Cap ' + g.capacity + ' &middot; ' + formatMoney(g.price_daily) + '/day &middot; ' + formatMoney(g.price_monthly) + '/month &middot; ' + formatMoney(g.price_quarterly) + '/quarter &middot; ' + formatMoney(g.price_yearly) + '/year</div></div>' +
          (g.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteGym(\'' + g.id + '\')">Delete</button></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Gym</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ag-name" placeholder="e.g. Sky Fitness Centre"/></div>' +
          '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="ag-type">' + GYM_TYPES.map(t => '<option>' + t + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><label class="form-label">Capacity (members)</label><input class="form-input" type="number" min="1" id="ag-cap" value="20"/></div>' +
          '<div class="form-group"><label class="form-label">Daily Registration ($)</label><input class="form-input" type="number" min="0" id="ag-daily" value="0"/></div>' +
          '<div class="form-group"><label class="form-label">Monthly Registration ($)</label><input class="form-input" type="number" min="0" id="ag-monthly" value="0"/></div>' +
          '<div class="form-group"><label class="form-label">Quarterly Registration ($)</label><input class="form-input" type="number" min="0" id="ag-quarterly" value="0"/></div>' +
          '<div class="form-group"><label class="form-label">Yearly Registration ($)</label><input class="form-input" type="number" min="0" id="ag-yearly" value="0"/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Facilities</label>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">' + FACILITY_OPTIONS.map((f, i) =>
            '<label style="display:flex;align-items:center;gap:5px;font-size:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:5px 9px;cursor:pointer"><input type="checkbox" class="ag-fac" value="' + escapeHtml(f) + '" id="ag-fac-' + i + '"/>' + escapeHtml(f) + '</label>').join('') +
          '</div></div>' +
        '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="ag-desc" placeholder="What makes this gym special…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addGym()">Add Gym</button>',
      { wide: true }
    );
  };
  window.__addGym = async () => {
    const name = document.getElementById('ag-name').value.trim();
    if (!name) { toast('Gym name is required', 'error'); return; }
    const facilities = Array.from(document.querySelectorAll('.ag-fac:checked')).map(c => c.value);
    try {
      await API.post('/api/gym/gyms', {
        name, type: document.getElementById('ag-type').value, facilities,
        capacity: Number(document.getElementById('ag-cap').value || 20),
        priceDaily: Number(document.getElementById('ag-daily').value || 0),
        priceMonthly: Number(document.getElementById('ag-monthly').value || 0),
        priceQuarterly: Number(document.getElementById('ag-quarterly').value || 0),
        priceYearly: Number(document.getElementById('ag-yearly').value || 0),
        description: document.getElementById('ag-desc').value.trim(),
      });
      toast('Gym added', 'success'); await load(); window.__manageGyms();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteGym = (id) => {
    confirmAction('Delete this gym? Gyms with active registrations cannot be deleted.', async () => {
      try { await API.del('/api/gym/gyms/' + id); toast('Gym deleted', 'warn'); await load(); window.__manageGyms(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
