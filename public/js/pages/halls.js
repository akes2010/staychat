// public/js/pages/halls.js
// Halls & Events — manage banquet/meeting-space inventory and their bookings,
// with automatic date/time conflict detection per hall.
window.PAGES = window.PAGES || {};

PAGES.halls = function () {
  const wrap = el('div', 'fa');
  const state = { halls: [], bookings: [], fnb: [], menu: null, carts: {}, fnbFilter: 'all', fnbBookingId: null, view: 'upcoming' };
  const canManageHalls = typeof can === 'function' ? can('halls.manage') : true;

  async function load() {
    wrap.innerHTML = loaderHTML('Loading halls & events…');
    try {
      const [halls, bookings, fnb] = await Promise.all([
        API.get('/api/halls/halls'), API.get('/api/halls/bookings'),
        API.get('/api/halls/fnb').catch(() => []),
      ]);
      state.halls = halls; state.bookings = bookings; state.fnb = Array.isArray(fnb) ? fnb : [];
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
        '<div style="text-align:right;min-width:90px"><div style="font-weight:800;color:var(--p)">' + formatMoney(b.total_amount) + '</div><div style="font-size:11px;color:var(--text3)">' + formatMoney(b.deposit_amount) + ' deposit</div>' +
          (b.fnb_total > 0 ? '<div style="font-size:11px;font-weight:600;color:var(--text2)">+ ' + formatMoney(b.fnb_total) + ' F&amp;B</div>' : '') + '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          (['tentative', 'confirmed'].includes(b.status) ? '<button class="btn ghost sm" onclick="window.__openHallFnb(\'' + b.id + '\')">🍽 Food &amp; Drinks</button>' : '') +
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
        (b.fnb_total > 0 ? '<div><strong>Food &amp; drinks:</strong> ' + formatMoney(b.fnb_total) + ' &nbsp; <strong>Event bill:</strong> ' + formatMoney(Number(b.total_amount || 0) + Number(b.fnb_total || 0)) + '</div>' : '') +
        (b.notes ? '<div><strong>Notes:</strong> ' + escapeHtml(b.notes) + '</div>' : '') +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      '<button class="btn primary" onclick="closeModal();window.__openHallFnb(\'' + b.id + '\')">🍽 Order Food &amp; Drinks</button>'
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
        '<div class="form-group" style="grid-column:1/-1;font-size:11.5px;color:var(--text3)">🕒 Bookings must fit inside the hall\'s bookable hours (set in Manage Halls → Hours).</div>' +
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
          '<div style="font-size:11px;color:var(--text3)">Cap ' + h.capacity + ' &middot; ' + formatMoney(h.hourly_rate) + '/hr &middot; ' + formatMoney(h.day_rate) + '/day</div>' +
          '<div style="font-size:11px;color:var(--text3);margin-top:2px">🕒 Bookable ' + escapeHtml(h.open_time || '07:00') + '–' + escapeHtml(h.close_time || '23:00') + '</div></div>' +
          (h.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" onclick="window.__editHallHours(\'' + h.id + '\')">Hours</button>' +
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
          '<div class="form-group"><label class="form-label">Bookable From</label><input class="form-input" type="time" id="ah-open" value="07:00"/></div>' +
          '<div class="form-group"><label class="form-label">Bookable Until</label><input class="form-input" type="time" id="ah-close" value="23:00"/></div>' +
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
        openTime: document.getElementById('ah-open').value, closeTime: document.getElementById('ah-close').value,
      });
      toast('Hall added', 'success'); await load(); window.__manageHalls();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__editHallHours = (id) => {
    const h = state.halls.find(x => x.id === id);
    if (!h) return;
    openModal('Bookable Hours — ' + escapeHtml(h.name),
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Bookable From</label><input class="form-input" type="time" id="hh-open" value="' + escapeHtml(h.open_time || '07:00') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Bookable Until</label><input class="form-input" type="time" id="hh-close" value="' + escapeHtml(h.close_time || '23:00') + '"/></div>' +
      '</div>' +
      '<p style="font-size:11.5px;color:var(--text3)">Desk and online event bookings must fit inside these hours.</p>',
      '<button class="btn outline" onclick="window.__manageHalls()">Back</button>' +
      '<button class="btn primary" onclick="window.__saveHallHours(\'' + id + '\')">Save Hours</button>'
    );
  };
  window.__saveHallHours = async (id) => {
    const openTime = document.getElementById('hh-open').value, closeTime = document.getElementById('hh-close').value;
    if (!openTime || !closeTime || closeTime <= openTime) { toast('Closing time must be after opening time', 'error'); return; }
    try {
      await API.patch('/api/halls/halls/' + id, { openTime, closeTime });
      toast('Bookable hours saved', 'success'); await load(); window.__manageHalls();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteHall = (id) => {
    confirmAction('Delete this hall? Halls with upcoming bookings cannot be deleted.', async () => {
      try { await API.del('/api/halls/halls/' + id); toast('Hall deleted', 'warn'); await load(); window.__manageHalls(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Food & Drinks for an event ─────────────────────────────────────────
  // Order food, drinks, or both straight from a hall booking. Prices come from
  // the server (menu_items), so the basket is only a quantity picker here.
  // Same classification the server uses to route an event order to the
  // restaurant or bar (server/utils/fnb.js), so the All/Food/Drinks pills
  // match the terminal the order will actually land on.
  const fnbIsDrink = (m) => {
    const cat = String(m.category || '').toLowerCase();
    return ['drinks', 'drink', 'beverages', 'beverage', 'cocktails', 'cocktail', 'mocktails', 'beer', 'beers', 'wine', 'wines', 'spirits', 'liquor', 'soft drinks', 'hot drinks'].includes(cat) ||
      /drink|cocktail|mocktail|beer|wine|spirit|liquor|juice|water|soda|smoothie|shake|coffee|tea|whisk|vodka|rum|gin|champagne|brandy|cognac|lemonade|sprite|coke|cola/i.test(String(m.name || ''));
  };
  const fnbOrdersFor = (id) => state.fnb.filter(o => o.hall_booking_id === id);
  const fnbCartTotal = (cart) => Object.keys(cart).reduce((s, k) => s + cart[k].price * cart[k].qty, 0);

  window.__openHallFnb = async (bookingId) => {
    const b = state.bookings.find(x => x.id === bookingId);
    if (!b) return;
    state.fnbBookingId = bookingId;
    state.fnbFilter = 'all';
    if (!state.carts[bookingId]) state.carts[bookingId] = {};
    try {
      const [menu, orders] = await Promise.all([
        state.menu ? Promise.resolve(state.menu) : API.get('/api/menu'),
        API.get('/api/halls/fnb?bookingId=' + encodeURIComponent(bookingId)),
      ]);
      state.menu = (Array.isArray(menu) ? menu : []).filter(m => m.available);
      state.fnb = Array.isArray(orders) ? orders : [];
    } catch (err) { toast(err.message, 'error'); return; }
    const hall = state.halls.find(h => h.id === b.hall_id);
    openModal('🍽 Food & Drinks — ' + escapeHtml(b.event_name),
      '<div id="hall-fnb-body"></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      '<button class="btn primary" onclick="window.__hallFnbPlace()">Place Order</button>',
      { wide: true, sub: escapeHtml(hall ? hall.name : 'Hall') + ' &middot; ' + fmtDate(b.event_date) + ' &middot; ' + b.start_time + '–' + b.end_time }
    );
    renderFnbBody();
  };

  function renderFnbBody() {
    const host = document.getElementById('hall-fnb-body');
    if (!host) return;
    const bookingId = state.fnbBookingId;
    const cart = state.carts[bookingId] || {};
    const menu = (state.menu || []).filter(m => state.fnbFilter === 'all' || (state.fnbFilter === 'food' ? !fnbIsDrink(m) : fnbIsDrink(m)));
    const cats = [];
    menu.forEach(m => { if (cats.indexOf(m.category) === -1) cats.push(m.category); });
    const cartLines = Object.keys(cart).map(k => cart[k]);
    const orders = fnbOrdersFor(bookingId).slice().sort((a, b2) => String(b2.created_at).localeCompare(String(a.created_at)));
    const tint = { pending: 'warn', preparing: 'info', served: 'success', cancelled: 'error' };

    const itemLine = (m) => {
      const q = cart[m.id] ? cart[m.id].qty : 0;
      return '<div style="display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px;background:' + (q ? 'var(--surface2)' : 'transparent') + '">' +
        '<div style="flex:1;min-width:0"><div style="font-size:12.5px;font-weight:600">' + escapeHtml(m.name) + '</div>' +
          (m.description ? '<div style="font-size:10.5px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(m.description) + '</div>' : '') + '</div>' +
        '<div style="font-size:12px;font-weight:700;min-width:58px;text-align:right">' + formatMoney(m.price) + '</div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          (q ? '<button class="btn ghost sm" style="padding:2px 9px" onclick="window.__hallFnbStep(\'' + m.id + '\',-1)">−</button><span style="font-weight:700;min-width:18px;text-align:center">' + q + '</span>' : '') +
          '<button class="btn outline sm" style="padding:2px 9px" onclick="window.__hallFnbStep(\'' + m.id + '\',1)">+</button></div></div>';
    };

    host.innerHTML =
      '<div class="filter-pills" style="margin-bottom:12px">' +
        [['all', 'All'], ['food', '🍽 Food'], ['drinks', '🍸 Drinks']].map(([v, label]) =>
          '<button class="pill ' + (state.fnbFilter === v ? 'active' : '') + '" onclick="window.__hallFnbFilter(\'' + v + '\')">' + label + '</button>').join('') +
      '</div>' +
      (menu.length === 0
        ? '<div class="empty-state" style="padding:22px"><div class="empty-state-icon">🍽</div><div class="empty-state-title">No products available</div><div class="empty-state-desc">Add food or drinks in Menu Manager to order them for events.</div></div>'
        : '<div style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:8px">' +
            cats.map(cat => '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3);padding:8px 10px 4px">' + escapeHtml(cat) + '</div>' +
              menu.filter(m => m.category === cat).map(itemLine).join('')).join('') + '</div>') +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 10px;font-size:13px">' +
        '<span style="color:var(--text3)">' + (cartLines.length ? cartLines.reduce((s, c) => s + c.qty, 0) + ' item(s) in this order' : 'Nothing in this order yet') + '</span>' +
        '<span style="font-weight:800;font-size:16px;color:var(--p)">' + formatMoney(fnbCartTotal(cart)) + '</span></div>' +
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Payment</label><select class="form-select" id="hall-fnb-payment">' +
          '<option value="event">Charge to event bill</option><option value="cash">Paid now — cash</option><option value="card">Paid now — card</option>' +
        '</select></div>' +
        '<div class="form-group"><label class="form-label">Note for kitchen / bar</label><input class="form-input" id="hall-fnb-note" placeholder="e.g. no onions, serve at 13:00"/></div>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:12px">' +
        '<div style="font-size:12px;font-weight:700;margin-bottom:8px">Orders for this event ' + (orders.length ? badge(String(orders.length), 'default') : '') + '</div>' +
        (orders.length === 0 ? '<div style="font-size:12px;color:var(--text3)">No food or drinks ordered yet.</div>' :
          '<div style="display:flex;flex-direction:column;gap:8px">' + orders.map(o =>
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--surface2);border-radius:9px;padding:9px 12px">' +
              '<div style="flex:1;min-width:160px"><div style="font-size:12px;font-weight:600">' + escapeHtml((o.items || []).map(i => i.qty + '× ' + i.name).join(', ')) + '</div>' +
                '<div style="font-size:10.5px;color:var(--text3)">' + (o.payment === 'event' ? 'Charged to event bill' : 'Paid ' + o.payment) + (o.note ? ' &middot; ' + escapeHtml(o.note) : '') + '</div></div>' +
              '<div style="font-weight:700;font-size:12.5px">' + formatMoney(o.total) + '</div>' + badge(o.status, tint[o.status] || 'default') +
              (o.status === 'pending' ? '<button class="btn outline sm" onclick="window.__hallFnbStatus(\'' + o.id + '\',\'preparing\')">Prepare</button>' : '') +
              (o.status === 'preparing' ? '<button class="btn primary sm" onclick="window.__hallFnbStatus(\'' + o.id + '\',\'served\')">Served</button>' : '') +
              (['pending', 'preparing'].includes(o.status) && o.payment === 'event' ? '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__hallFnbCancel(\'' + o.id + '\')">Cancel</button>' : '') +
            '</div>').join('') + '</div>') +
      '</div>';
  }

  window.__hallFnbFilter = (f) => { state.fnbFilter = f; renderFnbBody(); };
  window.__hallFnbStep = (menuItemId, delta) => {
    const bookingId = state.fnbBookingId;
    if (!bookingId) return;
    const cart = state.carts[bookingId] || (state.carts[bookingId] = {});
    const item = (state.menu || []).find(m => m.id === menuItemId);
    if (!item) return;
    const q = (cart[menuItemId] ? cart[menuItemId].qty : 0) + delta;
    if (q <= 0) delete cart[menuItemId];
    else cart[menuItemId] = { menuItemId, name: item.name, price: item.price, qty: q };
    renderFnbBody();
  };
  window.__hallFnbPlace = async () => {
    const bookingId = state.fnbBookingId;
    if (!bookingId) return;
    const cart = state.carts[bookingId] || {};
    const items = Object.keys(cart).map(k => ({ menuItemId: k, qty: cart[k].qty }));
    if (items.length === 0) { toast('Add at least one food or drink item', 'error'); return; }
    const paymentEl = document.getElementById('hall-fnb-payment');
    const noteEl = document.getElementById('hall-fnb-note');
    try {
      await API.post('/api/halls/bookings/' + bookingId + '/fnb', {
        items, payment: paymentEl ? paymentEl.value : 'event', note: noteEl ? noteEl.value.trim() : '',
      });
      toast('Food & drink order placed', 'success');
      state.carts[bookingId] = {};
      await load();
      window.__openHallFnb(bookingId);
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__hallFnbStatus = async (id, status) => {
    const bookingId = state.fnbBookingId;
    try {
      await API.patch('/api/halls/fnb/' + id, { status });
      toast('Order ' + status, status === 'served' ? 'success' : 'info');
      await load();
      window.__openHallFnb(bookingId);
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__hallFnbCancel = (id) => {
    const bookingId = state.fnbBookingId;
    confirmAction('Cancel this food & drink order? The amount comes off the event bill.', async () => {
      try {
        await API.patch('/api/halls/fnb/' + id, { status: 'cancelled' });
        toast('Order cancelled', 'warn');
        await load();
        window.__openHallFnb(bookingId);
      } catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
