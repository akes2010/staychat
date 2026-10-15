// public/js/pages/rooms.js
window.PAGES = window.PAGES || {};

PAGES.rooms = function () {
  const wrap = el('div', 'fa');
  const state = { filter: 'all', floorFilter: 'all', search: '', rooms: [], floors: [], categories: [], holidays: [], guests: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading rooms…');
    try {
      const [rooms, floors, categories, holidays, guests] = await Promise.all([API.get('/api/rooms'), API.get('/api/room-setup/floors'), API.get('/api/room-setup/categories'), API.get('/api/room-setup/holidays'), API.get('/api/guests')]);
      state.rooms = rooms; state.floors = floors; state.categories = categories; state.holidays = holidays; state.guests = guests;
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'rooms\')');
    }
  }

  function render() {
    const filtered = state.rooms.filter(r => {
      if (state.filter !== 'all' && r.status !== state.filter) return false;
      if (state.floorFilter !== 'all' && String(r.floor) !== String(state.floorFilter)) return false;
      if (state.search && !r.number.includes(state.search) && !r.type.toLowerCase().includes(state.search.toLowerCase())) return false;
      return true;
    });
    const availCount = state.rooms.filter(r => r.status === 'available').length;
    const occCount = state.rooms.filter(r => r.status === 'occupied').length;
    const floorNumbers = Array.from(new Set(state.rooms.map(r => r.floor))).sort((a, b) => a - b);

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Room Management</h1><p>' + availCount + ' available &middot; ' + occCount + ' occupied &middot; ' + state.rooms.length + ' total</p></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<div style="display:flex;align-items:center;gap:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-full);padding:7px 14px;flex:1;min-width:200px">' +
          '<span>🔍</span><input value="' + escapeHtml(state.search) + '" placeholder="Search room or type…" oninput="window.__roomsSearch(this.value)" style="border:none;outline:none;font-size:13px;color:var(--text);background:transparent;width:100%"/>' +
        '</div>' +
        '<button class="btn outline" onclick="window.__manageFloors()">Manage Floors</button>' +
        '<button class="btn outline" onclick="window.__manageCategories()">Categories &amp; Pricing</button>' +
        '<button class="btn primary" onclick="window.__openAddRoom()">+ Add Room</button>' +
      '</div></div>' +
    '<div class="filter-pills">' +
      ['all','available','occupied','dirty','maintenance','cleaning'].map(f => '<span class="pill' + (state.filter === f ? ' active' : '') + '" onclick="window.__roomsFilter(\'' + f + '\')">' + f.charAt(0).toUpperCase() + f.slice(1) + '</span>').join('') +
    '</div>' +
    (floorNumbers.length > 1 ? '<div class="filter-pills">' +
      '<span class="pill' + (state.floorFilter === 'all' ? ' active' : '') + '" onclick="window.__roomsFloorFilter(\'all\')">All Floors</span>' +
      floorNumbers.map(fn => {
        const floorRec = state.floors.find(f => f.number === fn);
        return '<span class="pill' + (String(state.floorFilter) === String(fn) ? ' active' : '') + '" onclick="window.__roomsFloorFilter(\'' + fn + '\')">' + (floorRec ? escapeHtml(floorRec.name) : 'Floor ' + fn) + '</span>';
      }).join('') +
    '</div>' : '') +
    '<div class="grid grid-rooms">' +
      filtered.map(room => {
        let body = '';
        if (room.status === 'available') body = '<div class="room-info" style="color:var(--p);font-weight:600;font-size:12px">Ready for check-in</div>';
        if (room.status === 'occupied' && room.guest_name) body = '<div class="room-info">👤 ' + escapeHtml(room.guest_name) + '</div>' + (room.checkout_label ? '<div style="font-size:11px;color:var(--text3)">Checkout: ' + escapeHtml(room.checkout_label) + '</div>' : '');
        if (room.status === 'dirty') body = '<button class="btn accent sm full" style="font-size:11px" onclick="event.stopPropagation();window.__quickClean(\'' + room.id + '\')">Assign Cleaning</button>';
        if (room.status === 'maintenance') body = '<div class="room-info" style="color:var(--error);background:var(--error-bg);padding:6px 9px;border-radius:7px;font-size:11px;font-weight:600">' + escapeHtml(room.issue || 'Issue pending') + '</div>';
        if (room.status === 'cleaning') body = '<div class="room-info" style="color:#7c3aed;font-size:11px;font-weight:600">Cleaning in progress…</div>';
        return '<div class="room-card ' + room.status + '" onclick="window.__openRoomModal(\'' + room.id + '\')">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px"><span style="font-size:10px;font-family:var(--font-mono);color:var(--text3)">ROOM</span>' + statusBadge(room.status) + '</div>' +
          '<div class="room-num">' + escapeHtml(room.number) + '</div><div class="room-type">' + escapeHtml(room.type) + ' &middot; ' + escapeHtml(room.view || '') + '</div><div class="room-divider"></div>' +
          body + '<div class="room-rate">' + formatMoney(room.rate) + '/night</div></div>';
      }).join('') +
      (filtered.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🏨</div><div class="empty-state-title">No rooms match filter</div></div>' : '') +
    '</div>';
  }

  window.__roomsFilter = (f) => { state.filter = f; render(); };
  window.__roomsFloorFilter = (f) => { state.floorFilter = f; render(); };
  window.__roomsSearch = (v) => { state.search = v; render(); };

  window.__quickClean = async (id) => {
    try {
      await API.patch('/api/rooms/' + id, { status: 'cleaning' });
      toast('Cleaning assigned', 'success');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__openRoomModal = (id) => {
    const room = state.rooms.find(r => r.id === id);
    if (!room) return;
    const statusOpts = room.status === 'occupied' ? ['occupied', 'available', 'dirty', 'maintenance', 'cleaning'] : ['available', 'dirty', 'maintenance', 'cleaning'];
    openModal('Room ' + escapeHtml(room.number),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">' +
        '<div class="form-group"><label class="form-label">Room Number</label><input class="form-input" id="rm-num" value="' + escapeHtml(room.number) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Type</label><input class="form-input" id="rm-type" value="' + escapeHtml(room.type) + '"/></div>' +
        '<div class="form-group"><label class="form-label">View</label><input class="form-input" id="rm-view" value="' + escapeHtml(room.view || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Floor</label><input class="form-input" type="number" id="rm-floor" value="' + room.floor + '"/></div>' +
        '<div class="form-group"><label class="form-label">Rate ($/night)</label><input class="form-input" type="number" id="rm-rate" value="' + room.rate + '"/></div>' +
        '<div class="form-group"><label class="form-label">Capacity</label><input class="form-input" type="number" id="rm-cap" value="' + room.capacity + '"/></div>' +
        '<div class="form-group"><label class="form-label">Status</label><select class="form-select" id="rm-status">' + statusOpts.map(s => '<option value="' + s + '"' + (room.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Current Guest</label><input class="form-input" value="' + escapeHtml(room.guest_name || '— none —') + '" disabled/></div>' +
      '</div>' +
      (room.status === 'occupied' ? '<p style="font-size:11px;color:var(--text3);margin-top:-8px;margin-bottom:14px">Guest is linked via Check-in and can only be changed by checking out and back in.</p>' : '') +
      '<div class="form-group"><label class="form-label">Maintenance Issue (if any)</label><input class="form-input" id="rm-issue" value="' + escapeHtml(room.issue || '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="rm-desc" value="' + escapeHtml(room.description || '') + '" placeholder="Notes about this room…"/></div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:16px">' +
        '<button class="btn accent" onclick="window.__checkInRoom(\'' + id + '\')">Check-in</button>' +
        '<button class="btn outline" onclick="window.__checkOutRoom(\'' + id + '\')">Check-out</button>' +
        '<button class="btn warn" onclick="window.__markMaintenanceRoom(\'' + id + '\')">Maintenance</button>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger sm" onclick="window.__deleteRoom(\'' + id + '\')">Delete</button><button class="btn primary" onclick="window.__saveRoom(\'' + id + '\')">Save Changes</button>',
      { sub: escapeHtml(room.type) + ' &middot; ' + escapeHtml(room.view || '') + ' &middot; Floor ' + room.floor }
    );
  };

  window.__saveRoom = async (id) => {
    try {
      await API.patch('/api/rooms/' + id, {
        number: document.getElementById('rm-num').value,
        type: document.getElementById('rm-type').value,
        view: document.getElementById('rm-view').value,
        floor: Number(document.getElementById('rm-floor').value),
        rate: Number(document.getElementById('rm-rate').value),
        capacity: Number(document.getElementById('rm-cap').value),
        status: document.getElementById('rm-status').value,
        issue: document.getElementById('rm-issue').value || null,
        description: document.getElementById('rm-desc').value || null,
      });
      toast('Room updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteRoom = (id) => {
    confirmAction('Delete this room permanently?', async () => {
      try { await API.del('/api/rooms/' + id); toast('Room deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__checkInRoom = (id) => {
    const room = state.rooms.find(r => r.id === id);
    openModal('Check In — Room ' + escapeHtml(room ? room.number : ''),
      '<div class="form-group"><label class="form-label">Select Guest</label><select class="form-select" id="ci-guest"><option value="">— Choose an existing guest —</option>' +
        state.guests.map(g => '<option value="' + g.id + '">' + escapeHtml(g.name) + (g.phone ? ' — ' + escapeHtml(g.phone) : '') + '</option>').join('') +
      '</select></div>' +
      '<div style="text-align:center;font-size:11px;color:var(--text3);margin:10px 0">— or register a new guest —</div>' +
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">New Guest Name</label><input class="form-input" id="ci-newname" placeholder="Full name"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="ci-newphone" placeholder="+234…"/></div>' +
      '</div>' +
      '<p style="font-size:11px;color:var(--text3)">A room can only be checked in against a real guest account — this cannot be left blank or filled with a placeholder name.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__confirmCheckIn(\'' + id + '\')">Check In</button>'
    );
  };
  window.__confirmCheckIn = async (id) => {
    let guestId = document.getElementById('ci-guest').value;
    const newName = document.getElementById('ci-newname').value.trim();
    let guestQueued = false;
    try {
      if (!guestId) {
        if (!newName) { toast('Select an existing guest or enter a name to register a new one', 'error'); return; }
        const guest = await API.post('/api/guests', { name: newName, phone: document.getElementById('ci-newphone').value.trim() }, { offline: true, label: 'Guest — ' + newName });
        if (guest && guest.__offlineQueued) {
          // The guest does not exist server-side yet. Queue the check-in
          // against the guest op's LOCAL id (its outbox id); once that op
          // syncs, the outbox rewrites the placeholder to the real guest id
          // before this check-in is replayed (strict FIFO order guarantees
          // the guest exists first).
          guestQueued = true;
          guestId = guest.__outboxId;
        } else {
          guestId = guest.id;
        }
      }
      const r = await API.post('/api/rooms/' + id + '/checkin', { guestId }, { offline: true, label: 'Room check-in' + (newName ? ' — ' + newName : '') });
      if (r && r.__offlineQueued) {
        toast('📴 Offline — check-in saved on this device' + (guestQueued ? ' together with the new guest' : '') + '; it syncs automatically when the connection returns.', 'warn', 7000);
        closeModal();
        return;
      }
      toast('Check-in complete', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__checkOutRoom = async (id) => {
    let check;
    try {
      check = await API.get('/api/rooms/' + id + '/checkout-check');
    } catch (err) {
      // Offline: the balance PREVIEW is unavailable — but the preview is UX
      // only. The server re-checks the REAL balance when the queued
      // check-out syncs and flags a conflict if money is still owed, so
      // proceeding here can never sneak an unpaid guest out.
      if (typeof navigator !== 'undefined' && !navigator.onLine) { check = { grandTotal: 0, offlinePreview: true }; }
      else { toast(err.message, 'error'); return; }
    }
    if (check.grandTotal > 0) {
      const canForce = typeof can === 'function' ? can('payments.manage') : false;
      openModal('Outstanding Balance',
        '<div style="background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:var(--radius);padding:14px;margin-bottom:14px">' +
          '<div style="font-weight:700;color:var(--warn)">⚠ ' + escapeHtml(check.guestName || 'This guest') + ' has an unpaid balance of ' + formatMoney(check.grandTotal) + '</div>' +
          '<div style="font-size:12px;color:var(--text3);margin-top:4px">' + formatMoney(check.roomBalance) + ' unpaid room balance + ' + formatMoney(check.pendingTotal) + ' from ' + check.pendingCount + ' other unpaid charge(s). Settle these in Payments before checking out.</div>' +
        '</div>' +
        (canForce ? '<p style="font-size:12px;color:var(--text3)">As a manager/owner, you may override this and check out anyway — the balance will remain on record as unpaid.</p>' : ''),
        '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
        '<button class="btn outline" onclick="window.__goSettleRoom(\'' + id + '\')">Go to Pay</button>' +
        (canForce ? '<button class="btn danger" onclick="window.__promptOverrideReasonRoom(\'' + id + '\')">Override &amp; Check Out</button>' : '')
      );
      return;
    }
    confirmAction('Check out this room? It will be marked dirty for housekeeping.', async () => {
      try {
        const r = await API.post('/api/rooms/' + id + '/checkout', {}, { offline: true, label: 'Room check-out' });
        if (r && r.__offlineQueued) { toast('📴 Offline — check-out saved on this device; it syncs automatically when the connection returns.', 'warn', 7000); closeModal(); return; }
        toast('Check-out done. Room marked dirty.', 'info'); closeModal(); await load();
      }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__goSettleRoom = (id) => {
    const room = state.rooms.find(r => r.id === id);
    closeModal();
    window.__pendingSettleTarget = { roomNumber: room ? room.number : null, checkoutRoomId: id };
    navigate('payments');
  };
  window.__promptOverrideReasonRoom = (id) => {
    openModal('Override Requires a Reason',
      '<p style="font-size:12px;color:var(--text3);margin-bottom:10px">This checkout will proceed with an outstanding balance still owed. Document why — this is recorded permanently against your name for audit purposes.</p>' +
      '<div class="form-group"><label class="form-label">Reason for Override</label><textarea class="form-input" id="ov-reason" rows="3" placeholder="e.g. Corporate account will be invoiced separately; guest ID on file; manager authorized…" oninput="document.getElementById(\'ov-confirm-btn\').disabled = !this.value.trim()"></textarea></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger" id="ov-confirm-btn" disabled onclick="window.__forceCheckOutRoom(\'' + id + '\')">Confirm Override &amp; Check Out</button>'
    );
  };
  window.__forceCheckOutRoom = async (id) => {
    const reason = document.getElementById('ov-reason').value.trim();
    if (!reason) { toast('A reason is required', 'error'); return; }
    try {
      const rOverride = await API.post('/api/rooms/' + id + '/checkout', { forceOverride: true, overrideReason: reason }, { offline: true, label: 'Room check-out (balance override)' });
      if (rOverride && rOverride.__offlineQueued) { toast('📴 Offline — override check-out saved; it syncs automatically when the connection returns.', 'warn', 7000); closeModal(); return; }
      toast('Checked out with an outstanding balance on record', 'warn'); closeModal(); await load();
    }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__markMaintenanceRoom = async (id) => {
    try { await API.patch('/api/rooms/' + id, { status: 'maintenance' }); toast('Room marked for maintenance', 'warn'); closeModal(); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__openAddRoom = () => {
    openModal('Add New Room',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Room Number</label><input class="form-input" id="nr-num" placeholder="e.g. 301"/></div>' +
        '<div class="form-group"><label class="form-label">View</label><input class="form-input" id="nr-view" placeholder="e.g. Ocean View"/></div>' +
        '<div class="form-group"><label class="form-label">Floor</label>' +
          (state.floors.length > 0
            ? '<select class="form-select" id="nr-floorid"><option value="">— No floor assigned —</option>' + state.floors.map(f => '<option value="' + f.id + '">' + escapeHtml(f.name) + ' (#' + f.number + ')</option>').join('') + '</select>'
            : '<input class="form-input" type="number" id="nr-floor" value="1"/>') + '</div>' +
        '<div class="form-group"><label class="form-label">Room Category</label>' +
          (state.categories.length > 0
            ? '<select class="form-select" id="nr-catid" onchange="window.__roomCategoryPicked()"><option value="">— Custom (set rate manually) —</option>' + state.categories.filter(c => c.active).map(c => '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>').join('') + '</select>'
            : '<input class="form-input" id="nr-type" placeholder="e.g. Deluxe King"/>') + '</div>' +
        '<div class="form-group"><label class="form-label">Rate ($/night)</label><input class="form-input" type="number" id="nr-rate" placeholder="0"/></div>' +
        '<div class="form-group"><label class="form-label">Capacity</label><input class="form-input" type="number" id="nr-cap" value="2"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Description (optional)</label><input class="form-input" id="nr-desc" placeholder="e.g. Corner room with balcony, recently renovated…"/></div>' +
      (state.categories.length === 0 ? '<p style="font-size:11px;color:var(--text3);margin-top:8px">Tip: set up Categories &amp; Pricing first to get automatic weekday/weekend/holiday/festive rates for new rooms.</p>' : ''),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addRoom()">Add Room</button>'
    );
  };
  window.__roomCategoryPicked = () => {
    const catId = document.getElementById('nr-catid').value;
    const cat = state.categories.find(c => c.id === catId);
    if (cat) { document.getElementById('nr-rate').value = cat.weekday_rate; document.getElementById('nr-cap').value = cat.capacity; }
  };
  window.__addRoom = async () => {
    const number = document.getElementById('nr-num').value.trim();
    if (!number) { toast('Room number required', 'error'); return; }
    const categoryId = document.getElementById('nr-catid') ? document.getElementById('nr-catid').value : '';
    const category = state.categories.find(c => c.id === categoryId);
    try {
      await API.post('/api/rooms', {
        number,
        type: document.getElementById('nr-type') ? document.getElementById('nr-type').value : (category ? category.name : 'Standard'),
        view: document.getElementById('nr-view').value || '',
        floorId: document.getElementById('nr-floorid') ? (document.getElementById('nr-floorid').value || undefined) : undefined,
        floor: document.getElementById('nr-floor') ? Number(document.getElementById('nr-floor').value) : undefined,
        categoryId: categoryId || undefined,
        rate: Number(document.getElementById('nr-rate').value) || undefined,
        capacity: Number(document.getElementById('nr-cap').value),
        description: document.getElementById('nr-desc').value.trim(),
      });
      toast('Room added', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Floors management ────────────────────────────────────────────────
  window.__manageFloors = () => {
    openModal('Manage Floors',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.floors.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No floors yet — add one below.</div>' :
        state.floors.map(f => '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(f.name) + ' <span style="color:var(--text3);font-weight:400">(#' + f.number + ')</span></div>' + (f.description ? '<div style="font-size:11px;color:var(--text3)">' + escapeHtml(f.description) + '</div>' : '') + '</div>' +
          badge(f.roomCount + ' room' + (f.roomCount === 1 ? '' : 's'), 'default') +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteFloor(\'' + f.id + '\')">Delete</button></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Floor</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Floor Number</label><input class="form-input" type="number" id="af-number" placeholder="e.g. 3"/></div>' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="af-name" placeholder="e.g. 3rd Floor — Deluxe Wing"/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Description (optional)</label><input class="form-input" id="af-desc" placeholder="Notes about this floor…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addFloor()">Add Floor</button>'
    );
  };
  window.__addFloor = async () => {
    const number = document.getElementById('af-number').value;
    const name = document.getElementById('af-name').value.trim();
    if (number === '' || !name) { toast('Floor number and name are required', 'error'); return; }
    try {
      await API.post('/api/room-setup/floors', { number: Number(number), name, description: document.getElementById('af-desc').value.trim() });
      toast('Floor added', 'success'); await load(); window.__manageFloors();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteFloor = (id) => {
    confirmAction('Delete this floor? Rooms must be moved off it first.', async () => {
      try { await API.del('/api/room-setup/floors/' + id); toast('Floor deleted', 'warn'); await load(); window.__manageFloors(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Room Categories & tiered pricing management ─────────────────────
  window.__manageCategories = () => {
    openModal('Room Categories &amp; Pricing',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.categories.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No categories yet — add one below.</div>' :
        state.categories.map(c => '<div style="background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><div style="flex:1;font-weight:600;font-size:13px">' + escapeHtml(c.name) + '</div>' +
          (c.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteCategory(\'' + c.id + '\')">Delete</button></div>' +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--text3)">' +
            '<span>Weekday: <strong style="color:var(--text)">' + formatMoney(c.weekday_rate) + '</strong></span>' +
            '<span>Weekend: <strong style="color:var(--text)">' + formatMoney(c.weekend_rate) + '</strong></span>' +
            '<span>Holiday: <strong style="color:var(--text)">' + formatMoney(c.holiday_rate) + '</strong></span>' +
            '<span>Festive: <strong style="color:var(--text)">' + formatMoney(c.festive_rate) + '</strong></span>' +
            (c.discount_pct ? '<span>Discount: <strong style="color:var(--a)">' + c.discount_pct + '%</strong></span>' : '') +
            '<span>Capacity: <strong style="color:var(--text)">' + c.capacity + '</strong></span>' +
          '</div></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Category</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ac-name" placeholder="e.g. Deluxe King"/></div>' +
          '<div class="form-group"><label class="form-label">Capacity</label><input class="form-input" type="number" min="1" id="ac-cap" value="2"/></div>' +
          '<div class="form-group"><label class="form-label">Weekday Rate ($)</label><input class="form-input" type="number" min="0" id="ac-weekday" placeholder="0.00"/></div>' +
          '<div class="form-group"><label class="form-label">Weekend Rate ($)</label><input class="form-input" type="number" min="0" id="ac-weekend" placeholder="defaults to weekday"/></div>' +
          '<div class="form-group"><label class="form-label">Holiday Rate ($)</label><input class="form-input" type="number" min="0" id="ac-holiday" placeholder="defaults to weekend"/></div>' +
          '<div class="form-group"><label class="form-label">Festive Rate ($)</label><input class="form-input" type="number" min="0" id="ac-festive" placeholder="defaults to holiday"/></div>' +
          '<div class="form-group"><label class="form-label">Discount (%)</label><input class="form-input" type="number" min="0" max="100" id="ac-discount" value="0"/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Description (optional)</label><input class="form-input" id="ac-desc" placeholder="What makes this category special…"/></div>' +
        '<p style="font-size:11px;color:var(--text3);margin-top:4px">Rooms in this category price at the festive rate on dates marked "Festive", the holiday rate on dates marked "Holiday", the weekend rate on Sat/Sun, and the weekday rate otherwise — with the discount applied on top. Manage dates below in Holidays &amp; Festive Dates.</p>' +
        '<div style="border-top:1px solid var(--border);margin-top:16px;padding-top:14px">' +
          '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Holidays &amp; Festive Dates</div>' +
          '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;max-height:120px;overflow-y:auto">' +
            (state.holidays.length === 0 ? '<div style="font-size:12px;color:var(--text3)">No dates configured yet.</div>' :
            state.holidays.map(h => '<div style="display:flex;align-items:center;gap:8px;background:var(--surface2);border-radius:7px;padding:6px 10px;font-size:12px">' +
              '<span style="flex:1">' + escapeHtml(h.name) + ' — ' + h.date + '</span>' + badge(h.type === 'festive' ? 'Festive' : 'Holiday', h.type === 'festive' ? 'warn' : 'info') +
              '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteHoliday(\'' + h.id + '\')">×</button></div>').join('')) +
          '</div>' +
          '<div class="form-row cols-2">' +
            '<div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="ah-date"/></div>' +
            '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ah-name" placeholder="e.g. Christmas Day"/></div>' +
            '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="ah-type"><option value="holiday">Holiday</option><option value="festive">Festive (premium)</option></select></div>' +
            '<div class="form-group" style="display:flex;align-items:flex-end"><button class="btn outline full" onclick="window.__addHoliday()">Add Date</button></div>' +
          '</div>' +
        '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addCategory()">Add Category</button>'
    );
  };
  window.__addCategory = async () => {
    const name = document.getElementById('ac-name').value.trim();
    if (!name) { toast('Category name is required', 'error'); return; }
    try {
      await API.post('/api/room-setup/categories', {
        name, capacity: Number(document.getElementById('ac-cap').value || 2),
        weekdayRate: Number(document.getElementById('ac-weekday').value || 0),
        weekendRate: document.getElementById('ac-weekend').value ? Number(document.getElementById('ac-weekend').value) : undefined,
        holidayRate: document.getElementById('ac-holiday').value ? Number(document.getElementById('ac-holiday').value) : undefined,
        festiveRate: document.getElementById('ac-festive').value ? Number(document.getElementById('ac-festive').value) : undefined,
        discountPct: Number(document.getElementById('ac-discount').value || 0),
        description: document.getElementById('ac-desc').value.trim(),
      });
      toast('Category added', 'success'); await load(); window.__manageCategories();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteCategory = (id) => {
    confirmAction('Delete this category? Rooms must be reassigned first.', async () => {
      try { await API.del('/api/room-setup/categories/' + id); toast('Category deleted', 'warn'); await load(); window.__manageCategories(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__addHoliday = async () => {
    const date = document.getElementById('ah-date').value;
    const name = document.getElementById('ah-name').value.trim();
    if (!date || !name) { toast('Date and name are required', 'error'); return; }
    try {
      await API.post('/api/room-setup/holidays', { date, name, type: document.getElementById('ah-type').value });
      toast('Date added', 'success'); await load(); window.__manageCategories();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteHoliday = async (id) => {
    try { await API.del('/api/room-setup/holidays/' + id); toast('Date removed', 'warn'); await load(); window.__manageCategories(); }
    catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
