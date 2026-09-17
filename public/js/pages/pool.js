// public/js/pages/pool.js
// Pool Booking — day-view of time-slotted pool reservations with capacity enforcement.
window.PAGES = window.PAGES || {};

PAGES.pool = function () {
  const wrap = el('div', 'fa');
  const state = { date: new Date().toISOString().slice(0, 10), bookings: [], rooms: [], guests: [], pools: [], capacity: 20 };
  const canManagePools = typeof can === 'function' ? can('pool.manage') : true;

  async function load() {
    wrap.innerHTML = loaderHTML('Loading pool schedule…');
    try {
      const [bookings, rooms, guests, settings, pools] = await Promise.all([
        API.get('/api/pool?date=' + state.date), API.get('/api/rooms'), API.get('/api/guests'), API.get('/api/settings'), API.get('/api/room-setup/pools'),
      ]);
      state.bookings = bookings; state.rooms = rooms; state.guests = guests; state.pools = pools;
      state.capacity = settings.poolCapacity || 20;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'pool\')'); }
  }

  function statusColor(s) { return { confirmed: 'info', checked_in: 'success', completed: 'default', cancelled: 'error', no_show: 'warn' }[s] || 'default'; }

  function render() {
    const active = state.bookings.filter(b => ['confirmed', 'checked_in'].includes(b.status));
    const headcount = active.reduce((s, b) => s + b.party_size, 0);
    const sorted = state.bookings.slice().sort((a, b) => a.start_time.localeCompare(b.start_time));

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Pool Bookings</h1><p>' + state.bookings.length + ' bookings on ' + fmtDate(state.date) + '</p></div>' +
      '<div style="display:flex;gap:10px">' + (canManagePools ? '<button class="btn outline" onclick="window.__managePools()">Manage Pools</button>' : '') + '<button class="btn primary" onclick="window.__openNewPoolBooking()">+ New Booking</button></div></div>' +
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap">' +
      '<input type="date" class="form-input" style="max-width:180px" value="' + state.date + '" onchange="window.__poolDateChange(this.value)"/>' +
      '<button class="btn outline sm" onclick="window.__poolDateChange(\'' + new Date().toISOString().slice(0, 10) + '\')">Today</button>' +
    '</div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      metricCard('Bookings Today', String(state.bookings.length), null, '🏊') +
      metricCard('Guests Booked', headcount + ' / ' + state.capacity, null, '👥') +
      metricCard('Cancelled / No-Show', String(state.bookings.filter(b => ['cancelled','no_show'].includes(b.status)).length), null, '⚠️') +
    '</div>' +
    (sorted.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🏊</div><div class="empty-state-title">No pool bookings for this date</div></div>' :
    '<div class="table-wrap"><table><thead><tr><th>Time</th><th>Guest</th><th>Room</th><th>Party Size</th><th>Area</th><th>Price</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      sorted.map(b => '<tr>' +
        '<td style="font-weight:600">' + b.start_time + ' – ' + b.end_time + '</td>' +
        '<td>' + escapeHtml(b.guest_name) + (b.guest_phone ? '<br/><span style="font-size:11px;color:var(--text3)">' + escapeHtml(b.guest_phone) + '</span>' : '') + '</td>' +
        '<td>' + (b.room_number ? escapeHtml(b.room_number) : '—') + '</td>' +
        '<td>' + b.party_size + '</td>' +
        '<td>' + escapeHtml(b.area) + '</td>' +
        '<td>' + formatMoney(b.price) + (b.paid ? ' ' + badge('Paid', 'success') : '') + '</td>' +
        '<td>' + badge(b.status.replace('_', ' '), statusColor(b.status)) + '</td>' +
        '<td>' + poolActionsHTML(b) + '</td>' +
      '</tr>').join('') + '</tbody></table></div>');
  }

  function poolActionsHTML(b) {
    if (b.status === 'confirmed') return '<div style="display:flex;gap:4px"><button class="btn ghost sm" onclick="window.__poolAction(\'' + b.id + '\',\'checkin\')">Check In</button><button class="btn ghost sm" style="color:var(--error)" onclick="window.__poolAction(\'' + b.id + '\',\'cancel\')">Cancel</button></div>';
    if (b.status === 'checked_in') return '<button class="btn ghost sm" onclick="window.__poolAction(\'' + b.id + '\',\'checkout\')">Complete</button>';
    return '<button class="btn ghost sm" onclick="window.__editPoolBooking(\'' + b.id + '\')">Edit</button>';
  }

  function fmtDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }

  window.__poolDateChange = (v) => { state.date = v; load(); };
  window.__poolAction = async (id, action) => {
    try { await API.post('/api/pool/' + id + '/' + action); toast('Updated', 'success'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__openNewPoolBooking = () => {
    const occupiedRooms = state.rooms.filter(r => r.status === 'occupied');
    if (state.pools.length === 0) { toast('Set up at least one pool first (Manage Pools)', 'error'); return; }
    openModal('New Pool Booking',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Guest Name</label><input class="form-input" id="np-name" placeholder="Full name"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="np-phone" placeholder="+234…"/></div>' +
        '<div class="form-group"><label class="form-label">Room (optional)</label><select class="form-select" id="np-room"><option value="">— Not a hotel guest —</option>' + occupiedRooms.map(r => '<option value="' + escapeHtml(r.number) + '">' + escapeHtml(r.number) + ' — ' + escapeHtml(r.guest_name || 'Guest') + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Party Size</label><input class="form-input" type="number" min="1" id="np-size" value="1"/></div>' +
        '<div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="np-date" value="' + state.date + '" min="' + new Date().toISOString().slice(0, 10) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Pool</label><select class="form-select" id="np-pool" onchange="window.__poolPicked()">' + state.pools.filter(p => p.active).map(p => '<option value="' + p.id + '" data-price="' + p.price + '">' + escapeHtml(p.name) + ' — ' + formatMoney(p.price) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Start Time</label><input class="form-input" type="time" id="np-start" value="10:00"/></div>' +
        '<div class="form-group"><label class="form-label">End Time</label><input class="form-input" type="time" id="np-end" value="12:00"/></div>' +
        '<div class="form-group"><label class="form-label">Price ($)</label><input class="form-input" type="number" min="0" id="np-price" value="' + (state.pools.find(p => p.active) ? state.pools.find(p => p.active).price : 0) + '"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="np-notes" placeholder="Optional notes…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitPoolBooking()">Book Slot</button>'
    );
  };
  window.__poolPicked = () => {
    const sel = document.getElementById('np-pool');
    const price = sel.options[sel.selectedIndex].dataset.price;
    document.getElementById('np-price').value = price;
  };
  window.__submitPoolBooking = async () => {
    const guestName = document.getElementById('np-name').value.trim();
    if (!guestName) { toast('Guest name is required', 'error'); return; }
    const roomSel = document.getElementById('np-room').value;
    const bookedDate = document.getElementById('np-date').value;
    try {
      await API.post('/api/pool', {
        guestName, guestPhone: document.getElementById('np-phone').value.trim(), roomNumber: roomSel || null,
        partySize: Number(document.getElementById('np-size').value || 1),
        date: bookedDate, poolId: document.getElementById('np-pool').value,
        startTime: document.getElementById('np-start').value, endTime: document.getElementById('np-end').value,
        price: Number(document.getElementById('np-price').value || 0), notes: document.getElementById('np-notes').value,
      });
      toast('Pool slot booked', 'success'); closeModal(); state.date = bookedDate; await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Manage pools (categorized areas with description/price) ────────────
  window.__managePools = () => {
    openModal('Manage Pools',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.pools.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No pools yet — add one below.</div>' :
        state.pools.map(p => '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(p.name) + ' ' + badge(p.category, 'default') + '</div>' +
          (p.description ? '<div style="font-size:11px;color:var(--text3);margin:2px 0">' + escapeHtml(p.description) + '</div>' : '') +
          '<div style="font-size:11px;color:var(--text3)">' + formatMoney(p.price) + ' &middot; Capacity ' + p.capacity + '</div></div>' +
          (p.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deletePool(\'' + p.id + '\')">Delete</button></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Pool</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ap-name" placeholder="e.g. Main Pool"/></div>' +
          '<div class="form-group"><label class="form-label">Category</label><select class="form-select" id="ap-category"><option>Standard</option><option>Kids</option><option>VIP</option><option>Adults Only</option><option>Outdoor</option></select></div>' +
          '<div class="form-group"><label class="form-label">Price ($ per booking)</label><input class="form-input" type="number" min="0" id="ap-price" value="0"/></div>' +
          '<div class="form-group"><label class="form-label">Capacity (guests)</label><input class="form-input" type="number" min="1" id="ap-cap" value="20"/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="ap-desc" placeholder="What makes this pool area special…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addPool()">Add Pool</button>'
    );
  };
  window.__addPool = async () => {
    const name = document.getElementById('ap-name').value.trim();
    if (!name) { toast('Pool name is required', 'error'); return; }
    try {
      await API.post('/api/room-setup/pools', {
        name, category: document.getElementById('ap-category').value, price: Number(document.getElementById('ap-price').value || 0),
        capacity: Number(document.getElementById('ap-cap').value || 20), description: document.getElementById('ap-desc').value.trim(),
      });
      toast('Pool added', 'success'); await load(); window.__managePools();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deletePool = (id) => {
    confirmAction('Delete this pool? Upcoming bookings must be cancelled or completed first.', async () => {
      try { await API.del('/api/room-setup/pools/' + id); toast('Pool deleted', 'warn'); await load(); window.__managePools(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__editPoolBooking = (id) => {
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;
    openModal('Edit Pool Booking',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Guest Name</label><input class="form-input" id="ep-name" value="' + escapeHtml(b.guest_name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Party Size</label><input class="form-input" type="number" min="1" id="ep-size" value="' + b.party_size + '"/></div>' +
        '<div class="form-group"><label class="form-label">Price ($)</label><input class="form-input" type="number" min="0" id="ep-price" value="' + b.price + '"/></div>' +
        '<div class="form-group"><label class="form-label">Paid</label><select class="form-select" id="ep-paid"><option value="true"' + (b.paid ? ' selected' : '') + '>Yes</option><option value="false"' + (!b.paid ? ' selected' : '') + '>No</option></select></div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__savePoolBooking(\'' + id + '\')">Save</button>'
    );
  };
  window.__savePoolBooking = async (id) => {
    try {
      await API.patch('/api/pool/' + id, {
        guestName: document.getElementById('ep-name').value.trim(), partySize: Number(document.getElementById('ep-size').value || 1),
        price: Number(document.getElementById('ep-price').value || 0), paid: document.getElementById('ep-paid').value === 'true',
      });
      toast('Booking updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
