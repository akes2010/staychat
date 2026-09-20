// public/js/pages/halls.js
// Halls & Events — manage banquet/meeting-space inventory and their bookings,
// with automatic date/time conflict detection per hall.
window.PAGES = window.PAGES || {};

PAGES.halls = function () {
  const wrap = el('div', 'fa');
  const state = { halls: [], bookings: [], view: 'upcoming' };
  const canManageHalls = typeof can === 'function' ? can('halls.manage') : true;

  async function load() {
    wrap.innerHTML = loaderHTML('Loading halls & events…');
    try {
      const [halls, bookings] = await Promise.all([API.get('/api/halls/halls'), API.get('/api/halls/bookings')]);
      state.halls = halls; state.bookings = bookings;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'halls\')'); }
  }

  function statusColor(s) { return { tentative: 'warn', confirmed: 'info', completed: 'success', cancelled: 'error' }[s] || 'default'; }

  function render() {
    const today = new Date().toISOString().slice(0, 10);
    let list = state.bookings.slice();
    if (state.view === 'upcoming') list = list.filter(b => b.event_date >= today && !['cancelled', 'completed'].includes(b.status));
    else if (state.view !== 'all') list = list.filter(b => b.status === state.view);
    list.sort((a, b) => (a.event_date + a.start_time).localeCompare(b.event_date + b.start_time));

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Halls &amp; Events</h1><p>' + state.halls.length + ' hall' + (state.halls.length === 1 ? '' : 's') + ' &middot; ' + state.bookings.length + ' bookings</p></div>' +
      '<div style="display:flex;gap:10px">' +
        (canManageHalls ? '<button class="btn outline" onclick="window.__manageHalls()">Manage Halls</button>' : '') +
        '<button class="btn primary" onclick="window.__openNewHallBooking()">+ New Booking</button>' +
      '</div></div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      state.halls.slice(0, 3).map(h => metricCard(h.name, h.capacity + ' cap', formatMoney(h.hourly_rate) + '/hr', '🎪')).join('') +
    '</div>' +
    (state.halls.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🎪</div><div class="empty-state-title">No halls set up yet</div><div class="empty-state-desc">Add a hall to start taking event bookings.</div>' + (canManageHalls ? '<button class="btn primary" style="margin-top:12px" onclick="window.__manageHalls()">Add a Hall</button>' : '') + '</div>' :
    '<div class="filter-pills" style="margin-bottom:16px">' +
      ['upcoming','tentative','confirmed','completed','cancelled','all'].map(f =>
        '<button class="pill ' + (state.view === f ? 'active' : '') + '" onclick="window.__hallView(\'' + f + '\')">' + f.charAt(0).toUpperCase() + f.slice(1) + '</button>'
      ).join('') +
    '</div>' +
    (list.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No bookings here</div></div>' :
    '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(b => {
      const hall = state.halls.find(h => h.id === b.hall_id);
      // Online submissions carry their tender code — show it so the desk can
      // verify the guest's slip without opening the Bookings page.
      const engineTag = (b.engine_sync_status === 'pending' && b.engine_code)
        ? '<span style="font-family:monospace;font-weight:800;font-size:12px;letter-spacing:1px;color:var(--p);background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:6px;padding:2px 8px">ONLINE · ' + escapeHtml(b.engine_code) + '</span>'
        : '';
      return '<div class="card" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 18px">' +
        '<div style="flex:1;min-width:200px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px"><span style="font-weight:700;font-size:14px">' + escapeHtml(b.event_name) + '</span>' + engineTag + badge(b.event_type, 'default') + statusBadge2(b.status) + '</div>' +
          '<div style="font-size:12px;color:var(--text3)">' + escapeHtml(hall ? hall.name : 'Unknown Hall') + ' &middot; ' + escapeHtml(b.organizer_name) + '</div>' +
        '</div>' +
        '<div style="text-align:center;min-width:140px"><div style="font-size:12px;font-weight:600">' + fmtDate(b.event_date) + '</div><div style="font-size:11px;color:var(--text3)">' + b.start_time + ' – ' + b.end_time + ' &middot; ' + b.guest_count + ' guests</div></div>' +
        '<div style="text-align:right;min-width:90px"><div style="font-weight:800;color:var(--p)">' + formatMoney(b.total_amount) + '</div><div style="font-size:11px;color:var(--text3)">' + formatMoney(b.deposit_amount) + ' deposit</div></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn ghost sm" onclick="window.__viewHallBooking(\'' + b.id + '\')">View</button>' +
          (b.status === 'tentative' ? '<button class="btn outline sm" onclick="window.__hallBookingAction(\'' + b.id + '\',\'confirm\')">Confirm</button>' : '') +
          (['tentative','confirmed'].includes(b.status) && b.event_date <= today ? '<button class="btn outline sm" onclick="window.__hallBookingAction(\'' + b.id + '\',\'complete\')">Complete</button>' : '') +
          (['tentative','confirmed'].includes(b.status) ? '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__hallBookingAction(\'' + b.id + '\',\'cancel\')">Cancel</button>' : '') +
        '</div>' +
      '</div>';
    }).join('') + '</div>'));
  }

  function statusBadge2(s) { return badge(s.charAt(0).toUpperCase() + s.slice(1), statusColor(s)); }
  function fmtDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }); }

  window.__hallView = (v) => { state.view = v; render(); };

  window.__hallBookingAction = async (id, action) => {
    try {
      if (action === 'confirm') await API.patch('/api/halls/bookings/' + id, { status: 'confirmed' });
      else await API.post('/api/halls/bookings/' + id + '/' + action);
      toast('Updated', 'success'); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__viewHallBooking = (id) => {
    const b = state.bookings.find(x => x.id === id);
    const hall = state.halls.find(h => h.id === b.hall_id);
    openModal('🎪 ' + escapeHtml(b.event_name),
      '<div style="display:flex;flex-direction:column;gap:10px;font-size:13px">' +
        '<div><strong>Hall:</strong> ' + escapeHtml(hall ? hall.name : '—') + '</div>' +
        '<div><strong>Status:</strong> ' + statusBadge2(b.status) + '</div>' +
        '<div><strong>Organizer:</strong> ' + escapeHtml(b.organizer_name) + (b.organizer_phone ? ' · ' + escapeHtml(b.organizer_phone) : '') + (b.organizer_email ? ' · ' + escapeHtml(b.organizer_email) : '') + '</div>' +
        '<div><strong>Date/Time:</strong> ' + fmtDate(b.event_date) + ', ' + b.start_time + ' – ' + b.end_time + '</div>' +
        '<div><strong>Guests:</strong> ' + b.guest_count + ' &middot; <strong>Setup:</strong> ' + escapeHtml(b.setup_style) + ' &middot; <strong>Catering:</strong> ' + (b.catering ? 'Yes' : 'No') + '</div>' +
        '<div><strong>Total:</strong> ' + formatMoney(b.total_amount) + ' &nbsp; <strong>Deposit:</strong> ' + formatMoney(b.deposit_amount) + '</div>' +
        (b.notes ? '<div><strong>Notes:</strong> ' + escapeHtml(b.notes) + '</div>' : '') +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>'
    );
  };

  // ── New / Edit event booking ────────────────────────────────────────────
  window.__openNewHallBooking = () => {
    if (state.halls.length === 0) { toast('Add a hall first', 'error'); return; }
    openModal('New Hall / Event Booking',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Hall</label><select class="form-select" id="hb-hall">' + state.halls.map(h => '<option value="' + h.id + '">' + escapeHtml(h.name) + ' (cap ' + h.capacity + ')</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Event Type</label><select class="form-select" id="hb-type"><option>Meeting</option><option>Wedding</option><option>Conference</option><option>Birthday</option><option>Corporate</option><option>Other</option></select></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">Event Name</label><input class="form-input" id="hb-name" placeholder="e.g. Adeyemi & Kemi Wedding Reception"/></div>' +
        '<div class="form-group"><label class="form-label">Organizer Name</label><input class="form-input" id="hb-org" placeholder="Full name"/></div>' +
        '<div class="form-group"><label class="form-label">Organizer Phone</label><input class="form-input" id="hb-phone" placeholder="+234…"/></div>' +
        '<div class="form-group"><label class="form-label">Event Date</label><input class="form-input" type="date" id="hb-date" min="' + new Date().toISOString().slice(0, 10) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Guest Count</label><input class="form-input" type="number" min="1" id="hb-count" value="50"/></div>' +
        '<div class="form-group"><label class="form-label">Start Time</label><input class="form-input" type="time" id="hb-start" value="10:00"/></div>' +
        '<div class="form-group"><label class="form-label">End Time</label><input class="form-input" type="time" id="hb-end" value="14:00"/></div>' +
        '<div class="form-group"><label class="form-label">Setup Style</label><select class="form-select" id="hb-setup"><option>Theatre</option><option>Banquet</option><option>Classroom</option><option>U-Shape</option><option>Cocktail</option></select></div>' +
        '<div class="form-group"><label class="form-label">Catering</label><select class="form-select" id="hb-catering"><option value="false">No</option><option value="true">Yes</option></select></div>' +
        '<div class="form-group"><label class="form-label">Total Amount ($)</label><input class="form-input" type="number" min="0" id="hb-total" value="0"/></div>' +
        '<div class="form-group"><label class="form-label">Deposit ($)</label><input class="form-input" type="number" min="0" id="hb-deposit" value="0"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="hb-notes" placeholder="Special requirements…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitHallBooking()">Create Booking</button>',
      { wide: true }
    );
  };
  window.__submitHallBooking = async () => {
    const eventName = document.getElementById('hb-name').value.trim();
    const organizerName = document.getElementById('hb-org').value.trim();
    const eventDate = document.getElementById('hb-date').value;
    if (!eventName || !organizerName || !eventDate) { toast('Event name, organizer, and date are required', 'error'); return; }
    try {
      await API.post('/api/halls/bookings', {
        hallId: document.getElementById('hb-hall').value, eventName, eventType: document.getElementById('hb-type').value,
        organizerName, organizerPhone: document.getElementById('hb-phone').value.trim(),
        eventDate, startTime: document.getElementById('hb-start').value, endTime: document.getElementById('hb-end').value,
        guestCount: Number(document.getElementById('hb-count').value || 1), setupStyle: document.getElementById('hb-setup').value,
        catering: document.getElementById('hb-catering').value === 'true',
        totalAmount: Number(document.getElementById('hb-total').value || 0), depositAmount: Number(document.getElementById('hb-deposit').value || 0),
        notes: document.getElementById('hb-notes').value,
      });
      toast('Event booking created', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Manage halls (inventory) ─────────────────────────────────────────
  window.__manageHalls = () => {
    openModal('Manage Halls',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.halls.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No halls yet — add one below.</div>' :
        state.halls.map(h => '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(h.name) + ' ' + badge(h.category || 'Standard', 'default') + '</div>' +
          (h.description ? '<div style="font-size:11px;color:var(--text3);margin:2px 0">' + escapeHtml(h.description) + '</div>' : '') +
          '<div style="font-size:11px;color:var(--text3)">Cap ' + h.capacity + ' &middot; ' + formatMoney(h.hourly_rate) + '/hr &middot; ' + formatMoney(h.day_rate) + '/day</div></div>' +
          (h.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteHall(\'' + h.id + '\')">Delete</button></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Hall</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ah-name" placeholder="e.g. Grand Ballroom"/></div>' +
          '<div class="form-group"><label class="form-label">Category</label><select class="form-select" id="ah-category"><option>Standard</option><option>Banquet</option><option>Conference</option><option>Outdoor</option><option>VIP</option></select></div>' +
          '<div class="form-group"><label class="form-label">Capacity</label><input class="form-input" type="number" min="1" id="ah-cap" value="50"/></div>' +
          '<div class="form-group"><label class="form-label">Hourly Rate ($)</label><input class="form-input" type="number" min="0" id="ah-hourly" value="0"/></div>' +
          '<div class="form-group"><label class="form-label">Full Day Rate ($)</label><input class="form-input" type="number" min="0" id="ah-day" value="0"/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="ah-desc" placeholder="What makes this hall special…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addHall()">Add Hall</button>'
    );
  };
  window.__addHall = async () => {
    const name = document.getElementById('ah-name').value.trim();
    if (!name) { toast('Hall name is required', 'error'); return; }
    try {
      await API.post('/api/halls/halls', {
        name, category: document.getElementById('ah-category').value,
        capacity: Number(document.getElementById('ah-cap').value || 50), hourlyRate: Number(document.getElementById('ah-hourly').value || 0),
        dayRate: Number(document.getElementById('ah-day').value || 0), description: document.getElementById('ah-desc').value.trim(),
      });
      toast('Hall added', 'success'); await load(); window.__manageHalls();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteHall = (id) => {
    confirmAction('Delete this hall? Halls with upcoming bookings cannot be deleted.', async () => {
      try { await API.del('/api/halls/halls/' + id); toast('Hall deleted', 'warn'); await load(); window.__manageHalls(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
