// public/js/pages/bookings.js
// Bookings & Reservations — single or group (multi-room) reservations, with
// confirmed → checked_in → checked_out lifecycle plus cancellation.
window.PAGES = window.PAGES || {};

PAGES.bookings = function () {
  const wrap = el('div', 'fa');
  const state = { bookings: [], rooms: [], guests: [], pendingFacilities: [], filter: 'upcoming', payMethods: ['cash', 'card'] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading reservations…');
    try {
      const [bookings, rooms, guests] = await Promise.all([API.get('/api/bookings'), API.get('/api/rooms'), API.get('/api/guests')]);
      state.bookings = bookings; state.rooms = rooms; state.guests = guests;
      // Facility (hall/pool) online submissions share the Pending tab.
      try { state.pendingFacilities = await API.get('/api/bookings/facilities/pending'); }
      catch (e) { state.pendingFacilities = []; }
      try {
        const settings = await API.get('/api/settings');
        if (settings && Array.isArray(settings.paymentMethods) && settings.paymentMethods.length) state.payMethods = settings.paymentMethods;
      } catch (e) { /* fall back to defaults */ }
      // New engine submissions deserve attention: land the desk on the Pending tab.
      const hasPending = state.bookings.some(b => b.status === 'pending_payment' && b.engineSyncStatus === 'pending')
        || (state.pendingFacilities && state.pendingFacilities.length > 0);
      if (hasPending && state.filter !== 'pending') state.filter = 'pending';
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'bookings\')'); }
  }

  function statusColor(s) {
    return { confirmed: 'info', checked_in: 'success', checked_out: 'default', cancelled: 'error', pending_payment: 'warning' }[s] || 'default';
  }

  // ── Pending facility (hall/pool) submissions ─────────────────────────────
  function pendingFacilityCount() { return (state.pendingFacilities || []).length; }

  // Rendered at the top of the Pending tab: each online hall/pool reservation
  // shows its tender code with one-click confirm/reject, mirroring rooms.
  function facilityBannerHTML() {
    if (state.filter !== 'pending' || !pendingFacilityCount()) return '';
    return state.pendingFacilities.map(f =>
      '<div style="background:var(--warn-bg);border:1.5px solid var(--warn-border);border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">' +
        '<span style="font-size:11px;font-weight:700;color:var(--text3)">ONLINE ' + (f.kind === 'hall' ? '🎪 HALL' : '🏊 POOL') + ' — TENDER CODE</span>' +
        '<span style="font-family:monospace;font-weight:800;font-size:16px;letter-spacing:2px;color:var(--p)">' + escapeHtml(f.engineCode || '—') + '</span>' +
        '<span style="font-weight:600;font-size:13px">' + escapeHtml(f.facilityName || '') + '</span>' +
        '<span style="font-size:12px;color:var(--text3)">' + escapeHtml(f.guestName || '') + ' · ' + escapeHtml(f.date || '') + ' ' + escapeHtml(f.startTime || '') + '–' + escapeHtml(f.endTime || '') + ' · ' + (f.partySize || 1) + ' guest' + ((f.partySize || 1) === 1 ? '' : 's') + ' · ' + formatMoney(f.totalAmount || 0) + '</span>' +
        '<span style="flex:1"></span>' +
        '<button class="btn primary sm" onclick="window.__confirmFacility(\'' + f.engineCode + '\')">✓ Confirm</button>' +
        '<button class="btn danger sm" onclick="window.__rejectFacility(\'' + f.engineCode + '\')">Reject</button>' +
      '</div>'
    ).join('');
  }

  function render() {
    const today = new Date().toISOString().slice(0, 10);
    let list = state.bookings.slice();
    if (state.filter === 'upcoming') list = list.filter(b => ['confirmed', 'checked_in'].includes(b.status));
    else if (state.filter === 'pending') list = list.filter(b => b.status === 'pending_payment' && b.engineSyncStatus === 'pending');
    else if (state.filter !== 'all') list = list.filter(b => b.status === state.filter);
    list.sort((a, b) => new Date(a.check_in) - new Date(b.check_in));

    const counts = {
      confirmed: state.bookings.filter(b => b.status === 'confirmed').length,
      checked_in: state.bookings.filter(b => b.status === 'checked_in').length,
      groups: state.bookings.filter(b => b.isGroup && ['confirmed', 'checked_in'].includes(b.status)).length,
    };

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Bookings &amp; Reservations</h1><p>' + state.bookings.length + ' total reservations</p></div>' +
      '<button class="btn primary" onclick="window.__openNewBooking()">+ New Reservation</button></div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      metricCard('Confirmed (Upcoming)', String(counts.confirmed), null, '📅') +
      metricCard('Currently Checked In', String(counts.checked_in), null, '🏨') +
      metricCard('Active Group Bookings', String(counts.groups), null, '👥') +
    '</div>' +
    '<div class="filter-pills" style="margin-bottom:16px">' +
      ['pending','upcoming','confirmed','checked_in','checked_out','cancelled','all'].map(f =>
        '<button class="pill ' + (state.filter === f ? 'active' : '') + '" onclick="window.__bookingFilter(\'' + f + '\')">' +
          f.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) + (f === 'pending' ? ' (' + (state.bookings.filter(b => b.status === 'pending_payment' && b.engineSyncStatus === 'pending').length + (state.pendingFacilities || []).length) + ')' : '') + '</button>'
      ).join('') +
    '</div>' +
    facilityBannerHTML() +
    (list.length === 0 && !pendingFacilityCount() ? '<div class="empty-state"><div class="empty-state-icon">📅</div><div class="empty-state-title">No reservations here</div><div class="empty-state-desc">Try a different filter or create a new reservation.</div></div>' :
    '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(b => {
      const roomsLabel = b.rooms.map(r => r.room_number).join(', ');
      // Online submissions show their tender code prominently with one-click
      // confirm/reject — the desk never has to hunt for the code.
      const pendingBanner = (b.status === 'pending_payment' && b.engineSyncStatus === 'pending')
        ? '<div style="background:var(--warn-bg);border:1.5px solid var(--warn-border);border-radius:var(--radius);padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
            '<span style="font-size:11px;font-weight:700;color:var(--text3)">ONLINE BOOKING — TENDER CODE</span>' +
            '<span style="font-family:monospace;font-weight:800;font-size:16px;letter-spacing:2px;color:var(--p)">' + escapeHtml(b.engineCode || '—') + '</span>' +
            '<span style="flex:1"></span>' +
            '<button class="btn primary sm" onclick="window.__confirmEngine(\'' + b.id + '\')">✓ Confirm</button>' +
            '<button class="btn danger sm" onclick="window.__rejectEngine(\'' + b.id + '\')">Reject</button>' +
          '</div>'
        : '';
      return pendingBanner + '<div class="card" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 18px">' +
        '<div style="flex:1;min-width:200px">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">' +
            '<span style="font-weight:700;font-size:14px">' + escapeHtml(b.isGroup ? (b.group_name || b.guest_name) : b.guest_name) + '</span>' +
            (b.isGroup ? badge('Group · ' + b.rooms.length + ' rooms', 'info') : '') +
            statusBadge(b.status) +
          '</div>' +
          '<div style="font-size:12px;color:var(--text3)">' + escapeHtml(b.reference) + ' &middot; Room' + (b.rooms.length > 1 ? 's' : '') + ' ' + escapeHtml(roomsLabel) + '</div>' +
        '</div>' +
        '<div style="text-align:center;min-width:130px">' +
          '<div style="font-size:12px;font-weight:600">' + fmtDate(b.check_in) + ' → ' + fmtDate(b.check_out) + '</div>' +
          '<div style="font-size:11px;color:var(--text3)">' + b.adults + ' adult' + (b.adults === 1 ? '' : 's') + (b.children ? ', ' + b.children + ' child' + (b.children === 1 ? '' : 'ren') : '') + '</div>' +
        '</div>' +
        '<div style="text-align:right;min-width:90px"><div style="font-weight:800;color:var(--p)">' + formatMoney(b.total_amount) + '</div><div style="font-size:11px;color:var(--text3)">' + formatMoney(b.paid_amount) + ' paid</div></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn ghost sm" onclick="window.__viewBooking(\'' + b.id + '\')">View</button>' +
          (!['checked_out', 'cancelled'].includes(b.status) ? '<button class="btn ghost sm" onclick="window.__editBooking(\'' + b.id + '\')">✎ Edit</button>' : '') +
          (!['checked_out', 'cancelled'].includes(b.status) ? '<button class="btn ghost sm" onclick="window.__transferBooking(\'' + b.id + '\')">🔀 Transfer</button>' : '') +
          (b.status === 'confirmed' ? '<button class="btn outline sm" onclick="window.__checkinBooking(\'' + b.id + '\')">Check In</button>' : '') +
          (b.status === 'checked_in' ? '<button class="btn outline sm" onclick="window.__checkoutBooking(\'' + b.id + '\')">Check Out</button>' : '') +
          (['confirmed'].includes(b.status) ? '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__cancelBooking(\'' + b.id + '\')">Cancel</button>' : '') +
          (b.status === 'checked_in' ? '<button class="btn ghost sm" onclick="window.__bookingWifi(\'' + b.id + '\')">📶 Wi-Fi</button>' : '') +
          (b.engineCode ? '<button class="btn ghost sm" onclick="window.__engineSlip(\'' + b.engineCode + '\')">🖨 Slip</button>' : '') +
        '</div>' +
      '</div>';
    }).join('') + '</div>');
  }

  function fmtDate(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

  window.__bookingFilter = (f) => { state.filter = f; render(); };

  // ── New reservation (single or group) ───────────────────────────────────
  let selectedRoomIds = [];
  let selectedPayMethod = null;
  // Exposed read-only for tests/extension hooks (mutations go through __toggleRoomPick).

  window.__openNewBooking = () => {
    // Resume a half-filled draft if one exists (e.g. the form was closed by
    // accident, or the page reloaded mid-registration). Drafts older than a
    // day are ignored — a desk wanting a fresh form clicks "Start fresh".
    const draft = loadDraft();
    if (draft && Array.isArray(draft.rooms) && Date.now() - draft.at < 864e5) {
      selectedRoomIds = draft.rooms.slice();
      selectedPayMethod = draft.pay || null;
      openModal('New Reservation — Continue your draft?',
        '<div style="font-size:13.5px;line-height:1.55;margin-bottom:14px">We saved what you had already filled in' +
          (draft.v && draft.v['nb-surname'] ? ' for <b>' + escapeHtml(draft.v['nb-surname']) : '') +
          (draft.v && draft.v['nb-firstname'] ? ' ' + escapeHtml(draft.v['nb-firstname']) + '</b>' : '') +
          (draft.rooms.length ? ' with <b>' + draft.rooms.length + ' room' + (draft.rooms.length === 1 ? '' : 's') + ' selected</b>' : '') + '. Continue where you left off, or start a fresh form.</div>',
        '<button class="btn outline" onclick="window.__startFreshBooking()">Start Fresh</button><button class="btn primary" onclick="window.__resumeDraftBooking()">Continue Draft</button>'
      );
      return;
    }
    startFreshBooking();
  };

  function startFreshBooking() {
    selectedRoomIds = [];
    selectedPayMethod = null;
    clearDraft();
    const available = state.rooms.filter(r => r.status === 'available');
    // Exposed for tests/extension hooks: the list the modal is showing.
    window.__bookingAvailableRooms = available;
    renderBookingForm(available);
  }
  window.__startFreshBooking = startFreshBooking;

  window.__resumeDraftBooking = () => {
    const draft = loadDraft();
    if (!draft) { startFreshBooking(); return; }
    const available = state.rooms.filter(r => r.status === 'available');
    window.__bookingAvailableRooms = available;
    renderBookingForm(available, { v: draft.v || {}, s: draft.s || {}, c: Object.assign({}, draft.c, { 'nb-group-toggle': !!draft.group }) });
    // renderBookingForm already applied the snapshot; make sure the group
    // toggle matches the resumed intent and the room highlight is live.
    const gt = document.getElementById('nb-group-toggle'); if (gt) gt.checked = !!draft.group;
  };

  const payIcons = { cash: ['💵', 'Cash'], card: ['💳', 'Card'], pos: ['🏧', 'POS Terminal'], bank_transfer: ['🏦', 'Bank Transfer'], check: ['📝', 'Check'], crypto: ['₿', 'Crypto'], paypal: ['🅿️', 'PayPal'], payoneer: ['💠', 'Payoneer'], airtm: ['🌐', 'Airtm'], mobile_transfer: ['📱', 'Mobile Transfer'], offline: ['📋', 'Offline'] };

  function otaSectionHTML(extRef, prepaid) {
    return '<div class="form-row cols-2" style="margin-bottom:8px">' +
      '<div class="form-group"><label class="form-label">OTA / Channel Reference</label><input class="form-input" id="nb-extref" value="' + escapeHtml(extRef || '') + '" placeholder="e.g. Booking.com confirmation no."/></div>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:10px;margin-top:22px"><label class="toggle"><input type="checkbox" id="nb-prepaid" ' + (prepaid ? 'checked' : '') + '/><span class="toggle-slider"></span></label><span style="font-size:13px">Already prepaid by the channel</span></div>' +
    '</div>';
  }

  function paySectionHTML(payAmount) {
    return '<div class="pos-pay-grid" style="margin-bottom:10px">' +
      (['none'].concat(state.payMethods)).map(m => {
        if (m === 'none') return '<div class="pos-pay-option' + (!selectedPayMethod ? ' selected' : '') + '" onclick="window.__selectPayMethod(\'none\')"><div class="pos-pay-ico">🚫</div><div class="pos-pay-label">None / pay later</div></div>';
        const [ico, label] = payIcons[m] || ['💰', m];
        return '<div class="pos-pay-option' + (selectedPayMethod === m ? ' selected' : '') + '" onclick="window.__selectPayMethod(\'' + m + '\')"><div class="pos-pay-ico">' + ico + '</div><div class="pos-pay-label">' + label + '</div></div>';
      }).join('') +
    '</div>' +
    (selectedPayMethod ? '<div class="form-group" style="margin-bottom:10px"><label class="form-label">Amount Paid Now ($)</label><input class="form-input" type="number" min="0" id="nb-payamount" value="' + escapeHtml(payAmount || '0') + '"/></div>' : '');
  }

  // ── FORM-STATE SNAPSHOT (the duplicate-form bug fix) ────────────────────
  // Clicking a room or toggling Group mode used to REBUILD the whole modal
  // (renderBookingForm → openModal → fresh DOM), wiping every field the desk
  // had already typed and turning the continuation of the same form into a
  // confusing second empty form. Now every re-render first SNAPS the current
  // DOM values, then re-applies them after the swap. Typed data and keyboard
  // focus survive exactly as the desk left them.
  const NB_FIELDS = ['nb-surname','nb-firstname','nb-phone','nb-email','nb-address','nb-idnumber',
    'nb-nok-name','nb-nok-phone','nb-checkin','nb-checkout','nb-adults','nb-children',
    'nb-groupname','nb-payamount','nb-extref','nb-notes'];
  const NB_SELECTS = ['nb-idtype','nb-country','nb-source'];
  let nbFocusId = null; // element about to lose focus on a room/group re-render

  // DRAFT PERSISTENCE — the belt-and-braces layer for the continuation bug.
  // Whatever happens (modal churn, accidental Cancel, full page reload), the
  // half-filled reservation survives in sessionStorage and is offered back the
  // next time the form opens. The in-page snapshot handles the live path; this
  // guards everything else.
  const NB_DRAFT_KEY = 'staychat.booking.draft';

  function saveDraft() {
    try {
      const v = {}; NB_FIELDS.forEach(id => { const e = document.getElementById(id); if (e && e.value) v[id] = e.value; });
      const s = {}; NB_SELECTS.forEach(id => { const e = document.getElementById(id); if (e && e.value) s[id] = e.value; });
      const gs = document.getElementById('nb-state'); if (gs && gs.value) s['nb-state'] = gs.value;
      const c = { group: !!document.getElementById('nb-group-toggle')?.checked, prepaid: !!document.getElementById('nb-prepaid')?.checked };
      sessionStorage.setItem(NB_DRAFT_KEY, JSON.stringify({
        v, s, c, rooms: selectedRoomIds.slice(), group: selectedRoomIds.length > 1,
        pay: selectedPayMethod, at: Date.now(),
      }));
    } catch (e) { /* storage unavailable — feature silently off */ }
  }

  function loadDraft() {
    try { return JSON.parse(sessionStorage.getItem(NB_DRAFT_KEY) || 'null'); } catch (e) { return null; }
  }

  function clearDraft() { try { sessionStorage.removeItem(NB_DRAFT_KEY); } catch (e) {} }

  function snapshotBookingForm() {
    const active = document.activeElement;
    nbFocusId = (active && active.id && active.id.startsWith('nb-')) ? active.id : null;
    const v = {}, s = {}, c = {};
    NB_FIELDS.forEach(id => { const e = document.getElementById(id); if (e) v[id] = e.value; });
    NB_SELECTS.forEach(id => { const e = document.getElementById(id); if (e) s[id] = e.value; });
    // individual-selects hidden behind source/group switches are captured live too
    const gst = document.getElementById('nb-state'); if (gst) s['nb-state'] = gst.value;
    c['nb-group-toggle'] = !!document.getElementById('nb-group-toggle')?.checked;
    c['nb-prepaid'] = !!document.getElementById('nb-prepaid')?.checked;
    // Scroll continuity: where is the desk's eyes at? (room grid, group name,
    // payment block…) Remember the offset and the room-grid anchor so the
    // re-render can land them EXACTLY where they were — not at the top of a
    // rebuilt form that reads like a second empty one.
    const bodyEl = document.querySelector('#modal .modal-body');
    const modalEl = document.getElementById('modal');
    // The actual scroll container is the WALLET-SIZED modal wrapper on desktop
    // (verified live: #modal scrolls; .modal-body does not) — snapshot both.
    return { v, s, c, scrollY: (modalEl && modalEl.scrollHeight > modalEl.clientHeight) ? modalEl.scrollTop : (bodyEl ? bodyEl.scrollTop : 0), scrollAnchorId: 'nb-room-grid' };
  }

  function applyBookingFormSnap(snap) {
    if (!snap) return;
    NB_FIELDS.forEach(id => { const e = document.getElementById(id); if (e && snap.v[id] !== undefined) e.value = snap.v[id]; });
    NB_SELECTS.forEach(id => { const e = document.getElementById(id); if (e && snap.s[id] !== undefined) e.value = snap.s[id]; });
    const gst = document.getElementById('nb-state'); if (gst && snap.s['nb-state'] !== undefined) gst.value = snap.s['nb-state'];
    const gt = document.getElementById('nb-group-toggle'); if (gt) gt.checked = snap.c['nb-group-toggle'];
    const pp = document.getElementById('nb-prepaid'); if (pp) pp.checked = snap.c['nb-prepaid'];
    // Restore keyboard focus so typing continues mid-field after a room click.
    if (nbFocusId) { const fe = document.getElementById(nbFocusId); if (fe) { try { fe.focus(); } catch (e) { /* non-focusable */ } } }
    nbFocusId = null;
  }

  function renderBookingForm(availableRooms, snap) {
    const isGroup = selectedRoomIds.length > 1 || document.getElementById('nb-group-toggle')?.checked;
    const country = (snap && snap.s['nb-country']) || document.getElementById('nb-country')?.value || '';
    const source = (snap && snap.s['nb-source']) || document.getElementById('nb-source')?.value || 'direct';
    const payAmount = (snap && snap.v['nb-payamount']) || document.getElementById('nb-payamount')?.value || '0';
    const extRef = (snap && snap.v['nb-extref']) || document.getElementById('nb-extref')?.value || '';
    const prepaid = (snap && snap.c['nb-prepaid']) || document.getElementById('nb-prepaid')?.checked || false;
    openModal('New Reservation',
      '<div class="form-group" style="margin-bottom:14px;display:flex;align-items:center;gap:10px">' +
        '<label class="toggle"><input type="checkbox" id="nb-group-toggle" ' + (isGroup ? 'checked' : '') + ' onchange="window.__toggleGroupMode()"/><span class="toggle-slider"></span></label>' +
        '<span style="font-size:13px;font-weight:600">Group Booking (multiple rooms, billed to one group account)</span>' +
      '</div>' +
      (isGroup ? '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Group / Party Name</label><input class="form-input" id="nb-groupname" placeholder="e.g. Adeyemi Wedding Party"/></div>' : '') +
      '<div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px">' + (isGroup ? 'Group Contact — Guest Details' : 'Guest Details') + '</div>' +
      '<div class="form-row cols-2" style="margin-bottom:12px">' +
        '<div class="form-group"><label class="form-label">Surname</label><input class="form-input" id="nb-surname" placeholder="e.g. Adeyemi"/></div>' +
        '<div class="form-group"><label class="form-label">First / Real Name</label><input class="form-input" id="nb-firstname" placeholder="e.g. Rotimi"/></div>' +
        '<div class="form-group"><label class="form-label">Phone Number</label><input class="form-input" id="nb-phone" placeholder="+234…"/></div>' +
        '<div class="form-group"><label class="form-label">Email (optional)</label><input class="form-input" type="email" id="nb-email" placeholder="name@example.com"/></div>' +
        '<div id="nb-guest-history" style="grid-column:1/-1"></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">Address</label><input class="form-input" id="nb-address" placeholder="Residential address"/></div>' +
        '<div class="form-group"><label class="form-label">Means of Identification</label><select class="form-select" id="nb-idtype">' + (window.ID_TYPES || []).map(t => '<option>' + t + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">ID Number</label><input class="form-input" id="nb-idnumber" placeholder="ID number"/></div>' +
        '<div class="form-group"><label class="form-label">Country</label><select class="form-select" id="nb-country" onchange="window.__countryChanged()">' +
          '<option value="">— Select country —</option>' + (window.COUNTRIES || []).map(c => '<option' + (country === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">State / Region</label>' + stateFieldHTML(country) + '</div>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px">Next of Kin</div>' +
      '<div class="form-row cols-2" style="margin-bottom:12px">' +
        '<div class="form-group"><label class="form-label">Next of Kin Name</label><input class="form-input" id="nb-nok-name" placeholder="Full name"/></div>' +
        '<div class="form-group"><label class="form-label">Next of Kin Phone</label><input class="form-input" id="nb-nok-phone" placeholder="+234…"/></div>' +
      '</div>' +
      '<div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px">Stay Details</div>' +
      '<div class="form-row cols-2" style="margin-bottom:12px">' +
        '<div class="form-group"><label class="form-label">Check-In Date</label><input class="form-input" type="date" id="nb-checkin" min="' + new Date().toISOString().slice(0, 10) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Check-Out Date</label><input class="form-input" type="date" id="nb-checkout"/></div>' +
        '<div class="form-group"><label class="form-label">Adults</label><input class="form-input" type="number" min="1" id="nb-adults" value="1"/></div>' +
        '<div class="form-group"><label class="form-label">Children</label><input class="form-input" type="number" min="0" id="nb-children" value="0"/></div>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:10px"><label class="form-label">' + (isGroup ? 'Check-In Room(s) — choose 2 or more' : 'Check-In Room') + '</label>' +
        '<div id="nb-room-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;max-height:180px;overflow-y:auto;padding:2px">' +
          availableRooms.map(r => {
            const sel = selectedRoomIds.includes(r.id);
            return '<div onclick="window.__toggleRoomPick(\'' + r.id + '\')" style="border:1.5px solid ' + (sel ? 'var(--p)' : 'var(--border)') + ';background:' + (sel ? 'linear-gradient(135deg,#e8f5e9,#d4ecd4)' : 'var(--surface)') + ';border-radius:9px;padding:8px 10px;cursor:pointer;text-align:center">' +
              '<div style="font-weight:700;font-size:13px">' + escapeHtml(r.number) + '</div><div style="font-size:10px;color:var(--text3)">' + escapeHtml(r.type || 'Room') + '</div><div style="font-size:11px;font-weight:600;color:var(--p)">' + formatMoney(r.rate) + '/night</div></div>';
          }).join('') +
        '</div>' +
        (availableRooms.length === 0 ? '<div style="font-size:12px;color:var(--text3);margin-top:6px">No available rooms right now.</div>' : '') +
      '</div>' +
      '<div class="form-group" style="margin-bottom:8px"><label class="form-label">Source</label>' +
        '<select class="form-select" id="nb-source" onchange="window.__sourceChanged()">' +
          ['direct', 'phone', 'whatsapp', 'ota', 'corporate'].map(s => {
            const lbl = { direct: 'Direct / Walk-in', phone: 'Phone', whatsapp: 'WhatsApp', ota: 'OTA / Booking Site', corporate: 'Corporate' }[s];
            return '<option value="' + s + '"' + (source === s ? ' selected' : '') + '>' + lbl + '</option>';
          }).join('') +
        '</select></div>' +
      '<div id="nb-ota-wrap">' + (source === 'ota' ? otaSectionHTML(extRef, prepaid) : '') + '</div>' +
      '<div style="font-size:12px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin:6px 0 8px">Payment (optional)</div>' +
      '<div id="nb-pay-wrap">' + paySectionHTML(payAmount) + '</div>' +
      '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="nb-notes" placeholder="Special requests…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitBooking()">Create Reservation</button>',
      { wide: true }
    );
    // Re-apply every typed value + keyboard focus the desk already had. This is
    // the fix for the continuation bug: the room pick / group toggle happens
    // MID-FORM, and the desk keeps typing exactly where they left off.
    applyBookingFormSnap(snap);
    // Preserve the desk's scroll position too: a room click re-renders the modal
    // body, and on screens where the form overflows (small laptops, POS
    // tablets) the rebuilt content snapped back to the top — the desk scrolled
    // from the top saw a fresh-looking second form and re-typed data. Capture
    // the scroll offset BEFORE the swap in snapshotBookingForm and restore it
    // here (clamped to the new height).
    const bodyElAfter = document.querySelector('#modal .modal-body');
    const modalElAfter = document.getElementById('modal');
    if (snap && typeof snap.scrollY === 'number') {
      const scroller = (modalElAfter && modalElAfter.scrollHeight > modalElAfter.clientHeight) ? modalElAfter : bodyElAfter;
      if (scroller) {
        // Keep the desk where the room grid lives — that's what they just
        // clicked, and on shorter screens a top-snap makes the same single
        // form read like a fresh second one.
        const anchor = snap.scrollAnchorId ? document.getElementById(snap.scrollAnchorId) : null;
        if (anchor) scroller.scrollTop = Math.max(0, anchor.offsetTop - 12);
        else scroller.scrollTop = Math.min(snap.scrollY, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
      }
    }
    // Every keystroke saves the draft (cheap, single-key) — an accidental close
    // or reload the next second can rescue everything typed so far.
    const body = document.querySelector('#modal .modal-body');
    if (body && !body.dataset.draftHooked) {
      body.dataset.draftHooked = '1';
      body.addEventListener('input', saveDraft);
      body.addEventListener('change', saveDraft);
    }
    hookReturningGuestAutofill();
    // Selection line is created lazily by room picks; draw it once on open so
    // resumed drafts show their count immediately.
    updateSelectionLine();
  }

  // ── RETURNING-GUEST AUTOFILL ────────────────────────────────────────────
  // Typing a phone number already known to the hotel fills THE WHOLE form
  // (name, email, address, ID, country/state, next of kin) from the guest's
  // last stay, with a small history strip. Never runs while any OTHER known
  // field has content — the desk may be deliberately re-keying a returning
  // guest whose details changed; the fill respects every field they've
  // already typed and only fills BLANK ones.
  let autofillLookingUp = false;
  async function hookReturningGuestAutofill() {
    const phoneEl = document.getElementById('nb-phone');
    if (!phoneEl || phoneEl.dataset.autofillHooked) return;
    phoneEl.dataset.autofillHooked = '1';
    phoneEl.addEventListener('blur', onPhoneBlur);
    phoneEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onPhoneBlur(); } });
  }

  async function onPhoneBlur() {
    if (autofillLookingUp) return;
    const phoneEl = document.getElementById('nb-phone');
    if (!phoneEl) return;
    const digits = phoneEl.value.replace(/[^\d]/g, '');
    if (digits.length < 7) return; // too short to match on

    // Never overwrite data the desk has deliberately typed already.
    const known = ['nb-surname','nb-firstname','nb-email','nb-address','nb-idnumber','nb-nok-name','nb-nok-phone']
      .map(id => document.getElementById(id)).filter(Boolean)
      .some(el => String(el.value).trim().length > 0);
    if (known) return;

    autofillLookingUp = true;
    try {
      const hit = await API.get('/api/bookings/returning-guest?phone=' + encodeURIComponent(phoneEl.value.trim()));
      if (!hit || !hit.matched || !hit.guest) return;
      const g = hit.guest;
      const fill = (id, val) => {
        const el = document.getElementById(id);
        if (el && val && !String(el.value).trim()) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
      };
      fill('nb-surname', g.surname);
      fill('nb-firstname', g.firstName);
      fill('nb-email', g.email);
      fill('nb-address', g.address);
      fill('nb-idnumber', g.idNumber);
      fill('nb-nok-name', g.nextOfKinName);
      fill('nb-nok-phone', g.nextOfKinPhone);
      // country then state/region (select per country, so set country first)
      if (g.country) {
        const cEl = document.getElementById('nb-country');
        if (cEl && !cEl.value) { cEl.value = g.country; cEl.dispatchEvent(new Event('change', { bubbles: true })); }
        if (g.state) setTimeout(() => { const sEl = document.getElementById('nb-state'); if (sEl && !sEl.value) sEl.value = g.state; }, 30);
      }
      // Load the ID-type select to a named option value if the lookup has one
      if (g.idType) { const itEl = document.getElementById('nb-idtype'); if (itEl && !itEl.value) itEl.value = g.idType; }

      const anyField = ['nb-surname','nb-firstname'].some(id => (document.getElementById(id) || {}).value);
      if (anyField) {
        const hist = (hit.history || []).slice(0, 3).map(h =>
          escapeHtml(h.reference) + ' · ' + escapeHtml(String(h.checkIn)) + '→' + escapeHtml(String(h.checkOut)) + ' · ' + statusBadge(h.status)).join('<br>');
        toast('✅ Returning guest — filled from their last stay (' + (hit.stayCount || 1) + ' stay' + ((hit.stayCount || 1) === 1 ? '' : 's') + ')', 'success', 5000);
        // A compact history strip in the form body — visibility, not decoration.
        const strip = document.getElementById('nb-guest-history');
        if (strip) strip.innerHTML = hist ? '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;font-size:11.5px;color:var(--text3);margin:-4px 0 12px"><b style="color:var(--p)">Stay history:</b><br>' + hist + '</div>' : '';
      }
      saveDraft(); // the autofill is data too — persist it in the draft
    } catch (err) { window.__autofillLastError = String(err && err.message || err); /* best-effort; never blocks form entry */ }
    finally { autofillLookingUp = false; }
  }

  function stateFieldHTML(country) {
    const states = (window.STATES_BY_COUNTRY || {})[country];
    if (states && states.length) {
      return '<select class="form-select" id="nb-state">' + states.map(s => '<option>' + s + '</option>').join('') + '</select>';
    }
    return '<input class="form-input" id="nb-state" placeholder="State / Region / Province"/>';
  }
  window.__countryChanged = () => {
    const country = document.getElementById('nb-country').value;
    document.getElementById('nb-state').outerHTML = stateFieldHTML(country);
  };

  window.__selectPayMethod = (m) => {
    const amt = document.getElementById('nb-payamount')?.value || '0';
    selectedPayMethod = (m === 'none' ? null : m);
    const wrap = document.getElementById('nb-pay-wrap');
    if (wrap) wrap.innerHTML = paySectionHTML(amt);
  };
  window.__sourceChanged = () => {
    const source = document.getElementById('nb-source')?.value || 'direct';
    const wrap = document.getElementById('nb-ota-wrap');
    if (wrap) wrap.innerHTML = source === 'ota' ? otaSectionHTML('', false) : '';
  };
  // Group toggle and room picks re-render the SAME form — snapshotting first so
  // every typed field, select choice and the focused field survive the swap.
  window.__toggleGroupMode = () => {
    if (!document.getElementById('nb-group-toggle').checked) selectedRoomIds = selectedRoomIds.slice(0, 1);
    renderBookingForm(state.rooms.filter(r => r.status === 'available'), snapshotBookingForm());
  };
  // Room picks no longer re-render the whole modal — that full innerHTML swap
  // made the form flicker/shake on every click (parse + relayout of a tall
  // form, scrollbar jump). The modal only changes in exactly three spots:
  // a room tile's highlight, the “N room(s) selected…” line, and nothing
  // else. Update those in place; the form never moves.
  function refreshRoomPickVisuals() {
    const grid = document.getElementById('nb-room-grid');
    if (grid) {
      const rooms = window.__bookingAvailableRooms || [];
      const byId = Object.fromEntries(rooms.map(r => [r.id, r]));
      [...grid.children].forEach(tile => {
        const m = (tile.getAttribute('onclick') || '').match(/__toggleRoomPick\('([^']+)'\)/);
        if (!m) return;
        const sel = selectedRoomIds.includes(m[1]);
        tile.style.borderColor = sel ? 'var(--p)' : 'var(--border)';
        tile.style.background = sel ? 'linear-gradient(135deg,#e8f5e9,#d4ecd4)' : 'var(--surface)';
      });
    }
    updateSelectionLine();
    try { saveDraft(); } catch (e) {}
  }

  // The selection summary lives at the very end of the form body; keep one
  // element and rewrite its text (never insert/remove — avoids layout jumps).
  function updateSelectionLine() {
    const body = document.querySelector('#modal .modal-body');
    if (!body) return;
    let line = document.getElementById('nb-selection-line');
    const isGroup = document.getElementById('nb-group-toggle')?.checked;
    if (!line) {
      line = document.createElement('div');
      line.id = 'nb-selection-line';
      line.style.cssText = 'margin-top:10px;font-size:12px;color:var(--text3)';
      body.appendChild(line);
    }
    line.innerHTML = selectedRoomIds.length > 0
      ? selectedRoomIds.length + ' room' + (selectedRoomIds.length === 1 ? '' : 's') + ' selected &middot; will be billed to the ' + (isGroup ? 'group account' : 'individual guest')
      : '';
  }

  window.__toggleRoomPick = (roomId) => {
    const isGroup = document.getElementById('nb-group-toggle')?.checked;
    if (!isGroup) { selectedRoomIds = selectedRoomIds.includes(roomId) ? [] : [roomId]; }
    else {
      selectedRoomIds = selectedRoomIds.includes(roomId) ? selectedRoomIds.filter(id => id !== roomId) : [...selectedRoomIds, roomId];
    }
    Object.defineProperty(window, '__bookingSelectedRoomIds', { value: selectedRoomIds.slice(), configurable: true, writable: true });
    // Individual→group and back can change which rooms are allowed to be
    // selected; keep the list legal without re-rendering the modal.
    refreshRoomPickVisuals();
  };

  window.__submitBooking = async () => {
    const isGroup = document.getElementById('nb-group-toggle').checked;
    const surname = document.getElementById('nb-surname').value.trim();
    const firstName = document.getElementById('nb-firstname').value.trim();
    const checkIn = document.getElementById('nb-checkin').value;
    const checkOut = document.getElementById('nb-checkout').value;
    if (!surname && !firstName) { toast('Surname or first name is required', 'error'); return; }
    if (!checkIn || !checkOut) { toast('Check-in and check-out dates are required', 'error'); return; }
    if (selectedRoomIds.length === 0) { toast('Select at least one check-in room', 'error'); return; }
    if (isGroup && selectedRoomIds.length < 2) { toast('Group bookings need 2 or more rooms — or turn off Group Booking', 'error'); return; }

    const source = document.getElementById('nb-source').value;
    const payAmount = selectedPayMethod ? Number(document.getElementById('nb-payamount')?.value || 0) : 0;
    if (payAmount > 0 && !selectedPayMethod) { toast('Choose a payment method for the amount collected', 'error'); return; }
    if (selectedPayMethod && payAmount <= 0) { toast('Enter an amount for the selected payment method, or choose "None / pay later"', 'error'); return; }

    try {
      const booking = await API.post('/api/bookings', {
        surname, firstName, guestPhone: document.getElementById('nb-phone').value.trim(),
        guestEmail: document.getElementById('nb-email').value.trim(),
        address: document.getElementById('nb-address').value.trim(),
        idType: document.getElementById('nb-idtype').value, idNumber: document.getElementById('nb-idnumber').value.trim(),
        country: document.getElementById('nb-country').value, state: document.getElementById('nb-state')?.value || '',
        nextOfKinName: document.getElementById('nb-nok-name').value.trim(), nextOfKinPhone: document.getElementById('nb-nok-phone').value.trim(),
        checkIn, checkOut, roomIds: selectedRoomIds, isGroup,
        groupName: isGroup ? document.getElementById('nb-groupname')?.value.trim() : null,
        adults: Number(document.getElementById('nb-adults').value || 1),
        children: Number(document.getElementById('nb-children').value || 0),
        source,
        externalRef: source === 'ota' ? (document.getElementById('nb-extref')?.value.trim() || null) : null,
        prepaid: source === 'ota' ? !!document.getElementById('nb-prepaid')?.checked : false,
        payment: payAmount > 0 && selectedPayMethod ? { amount: payAmount, method: selectedPayMethod } : null,
        notes: document.getElementById('nb-notes').value,
      }, { offline: true, label: 'Reservation — ' + ((surname || firstName) || 'new') + (checkIn ? ' (' + checkIn + ')' : '') });
      if (booking && booking.__offlineQueued) {
        clearDraft(); // a completed registration is no longer a draft
        closeModal();
        toast('📴 Offline — reservation saved on this device. It will sync automatically when the connection returns.', 'warn', 7000);
        return;
      }
      clearDraft(); // a completed registration is no longer a draft
      toast('Reservation created', 'success');
      if (payAmount > 0) {
        const balanceRemaining = Math.max(0, booking.total_amount - payAmount);
        const methodLabel = selectedPayMethod.charAt(0).toUpperCase() + selectedPayMethod.slice(1).replace('_', ' ');
        showReceiptPopup({
          hotelName: (App.tenant && App.tenant.name) || 'StayChat OS',
          subtitle: 'Reservation ' + escapeHtml(booking.reference),
          title: payAmount >= booking.total_amount ? 'BOOKING RECEIPT — PAID IN FULL' : 'BOOKING RECEIPT — ADVANCE PAYMENT',
          defaultPaper: '210mm',
          meta: [
            ['Date', new Date().toLocaleString()], ['Guest', escapeHtml(booking.guest_name)],
            ['Check-In', fmtDate(booking.check_in)], ['Check-Out', fmtDate(booking.check_out)],
            ['Room(s)', booking.rooms.map(r => r.room_number).join(', ')],
            ['Payment Method', methodLabel],
          ],
          lines: booking.rooms.map(r => ['Room ' + r.room_number, '', formatMoney(r.rate) + '/night']),
          totals: [
            ['Room Total', formatMoney(booking.total_amount)],
            ['Amount Paid Now', formatMoney(payAmount)],
            ['Balance Remaining', formatMoney(balanceRemaining), true],
          ],
          footer: balanceRemaining > 0 ? 'Balance is due at check-out or check-in.' : 'Fully paid — see you soon!',
        });
      } else {
        closeModal();
      }
      await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── View / actions ───────────────────────────────────────────────────
  window.__viewBooking = (id) => {
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;
    openModal((b.isGroup ? '👥 ' : '🛏 ') + escapeHtml(b.isGroup ? (b.group_name || b.guest_name) : b.guest_name),
      '<div style="display:flex;flex-direction:column;gap:10px;font-size:13px">' +
        '<div><strong>Reference:</strong> ' + escapeHtml(b.reference) + '</div>' +
        '<div><strong>Status:</strong> ' + statusBadge(b.status) + ' &nbsp; <strong>Billed To:</strong> ' + badge(b.billed_to === 'group' ? 'Group Account' : 'Individual', b.billed_to === 'group' ? 'info' : 'default') + '</div>' +
        '<div><strong>Contact:</strong> ' + escapeHtml(b.guest_name) + (b.guest_phone ? ' · ' + escapeHtml(b.guest_phone) : '') + (b.guest_email ? ' · ' + escapeHtml(b.guest_email) : '') + '</div>' +
        (b.address ? '<div><strong>Address:</strong> ' + escapeHtml(b.address) + '</div>' : '') +
        (b.id_type || b.id_number ? '<div><strong>ID:</strong> ' + escapeHtml(b.id_type || '') + (b.id_number ? ' · ' + escapeHtml(b.id_number) : '') + '</div>' : '') +
        (b.country ? '<div><strong>Location:</strong> ' + escapeHtml(b.state ? b.state + ', ' : '') + escapeHtml(b.country) + '</div>' : '') +
        (b.next_of_kin_name ? '<div><strong>Next of Kin:</strong> ' + escapeHtml(b.next_of_kin_name) + (b.next_of_kin_phone ? ' · ' + escapeHtml(b.next_of_kin_phone) : '') + '</div>' : '') +
        '<div><strong>Dates:</strong> ' + fmtDate(b.check_in) + ' → ' + fmtDate(b.check_out) + '</div>' +
        '<div><strong>Party:</strong> ' + b.adults + ' adults, ' + b.children + ' children</div>' +
        '<div><strong>Rooms:</strong> ' + b.rooms.map(r => r.room_number + ' (' + formatMoney(r.rate) + '/night)').join(', ') + '</div>' +
        '<div><strong>Room Total:</strong> ' + formatMoney(b.total_amount) + ' &nbsp; <strong>Paid/Deposit:</strong> ' + formatMoney(b.paid_amount + b.deposit_amount) + '</div>' +
        (b.notes ? '<div><strong>Notes:</strong> ' + escapeHtml(b.notes) + '</div>' : '') +
        '<div style="font-size:11px;color:var(--text3)">Booked via ' + escapeHtml(b.source) + ' by ' + escapeHtml(b.created_by || '—') + '</div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      (!['checked_out', 'cancelled'].includes(b.status) ? '<button class="btn ghost" onclick="closeModal(); window.__editBooking(\'' + b.id + '\')">✎ Edit</button>' : '') +
      (!['checked_out', 'cancelled'].includes(b.status) ? '<button class="btn ghost" onclick="closeModal(); window.__transferBooking(\'' + b.id + '\')">🔀 Transfer</button>' : '') +
      (b.isGroup ? '<button class="btn primary" onclick="window.__viewGroupFolio(\'' + b.id + '\')">View Group Folio</button>' : '')
    );
  };

  window.__viewGroupFolio = async (id) => {
    try {
      const folio = await API.get('/api/bookings/' + id + '/folio');
      openModal('Group Folio — ' + escapeHtml(folio.booking.group_name || folio.booking.guest_name),
        '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px;margin-bottom:14px">' +
          '<div style="display:flex;justify-content:space-between"><span>Room Charges (' + folio.booking.rooms.length + ' rooms)</span><span style="font-weight:700">' + formatMoney(folio.roomTotal) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between"><span>Incidentals (POS, etc.)</span><span style="font-weight:700">' + formatMoney(folio.incidentalsTotal) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;border-top:1.5px dashed var(--border-dark);padding-top:8px;font-weight:800;font-size:15px"><span>Grand Total</span><span style="color:var(--p)">' + formatMoney(folio.grandTotal) + '</span></div>' +
        '</div>' +
        (folio.charges.length === 0 ? '<div style="font-size:12px;color:var(--text3)">No incidental charges posted to this group account yet.</div>' :
        '<div class="table-wrap"><table><thead><tr><th>Description</th><th>Method</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>' +
          folio.charges.map(c => '<tr><td>' + escapeHtml(c.description || '') + '</td><td>' + escapeHtml(c.method) + '</td><td>' + formatMoney(c.amount) + '</td><td>' + statusBadge(c.status) + '</td><td style="font-size:11px;color:var(--text3)">' + timeAgo(c.created_at) + '</td></tr>').join('') +
        '</tbody></table></div>'),
        '<button class="btn outline" onclick="closeModal()">Close</button>'
      );
    } catch (err) { toast(err.message, 'error'); }
  };
  // ── EDIT RESERVATION ─────────────────────────────────────────
  // Desk correction of a live reservation: contact details, dates, party size,
  // notes, and (managers/owners only) the re-price. Dates are re-validated against
  // availability server-side (PATCH /api/bookings/:id) and any conflict comes back
  // as a 409 with a readable message shown as a toast.
  window.__editBooking = (id) => {
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;
    if (['checked_out', 'cancelled'].includes(b.status)) { toast('This booking is ' + b.status + ' and can no longer be edited', 'warn'); return; }
    const canPrice = typeof can === 'function' ? can('pricing.manage') : false;
    openModal('✎ Edit Reservation — ' + escapeHtml(b.reference),
      '<div style="display:flex;flex-direction:column;gap:10px">' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Guest Surname</label><input class="form-input" id="eb-surname" value="' + escapeHtml(b.surname || '') + '"/></div>' +
          '<div class="form-group"><label class="form-label">First Name</label><input class="form-input" id="eb-firstname" value="' + escapeHtml(b.first_name || '') + '"/></div>' +
        '</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Guest Name (folio display)</label><input class="form-input" id="eb-name" value="' + escapeHtml(b.guest_name || '') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="eb-phone" value="' + escapeHtml(b.guest_phone || '') + '"/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="eb-email" value="' + escapeHtml(b.guest_email || '') + '"/></div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Check-in</label><input class="form-input" type="date" id="eb-in" value="' + escapeHtml((b.check_in || '').slice(0, 10)) + '"/></div>' +
          '<div class="form-group"><label class="form-label">Check-out</label><input class="form-input" type="date" id="eb-out" value="' + escapeHtml((b.check_out || '').slice(0, 10)) + '"/></div>' +
        '</div>' +
        '<div class="form-row cols-3">' +
          '<div class="form-group"><label class="form-label">Adults</label><input class="form-input" type="number" min="1" id="eb-adults" value="' + (b.adults || 1) + '"/></div>' +
          '<div class="form-group"><label class="form-label">Children</label><input class="form-input" type="number" min="0" id="eb-children" value="' + (b.children || 0) + '"/></div>' +
          '<div class="form-group"><label class="form-label">Total ($)' + (canPrice ? '' : ' — manager only') + '</label><input class="form-input" type="number" min="0" step="0.01" id="eb-total" value="' + (b.total_amount != null ? b.total_amount : '') + '"' + (canPrice ? '' : ' disabled') + '/></div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Notes</label><textarea class="form-input" id="eb-notes" rows="2">' + escapeHtml(b.notes || '') + '</textarea></div>' +
        '<div style="font-size:11px;color:var(--text3)">The guest\'s original rate is kept. Changing dates is re-checked against room availability automatically.</div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
      '<button class="btn primary" onclick="window.__saveBookingEdit(\'' + b.id + '\')">Save Changes</button>'
    );
  };

  window.__saveBookingEdit = async (id) => {
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;
    const val = (elId) => { const el = document.getElementById(elId); return el ? el.value.trim() : undefined; };
    const body = {};
    const surname = val('eb-surname'); const firstName = val('eb-firstname');
    if (surname !== undefined) body.surname = surname;
    if (firstName !== undefined) body.firstName = firstName;
    if (surname || firstName) body.guestName = ((firstName || b.first_name || '') + ' ' + (surname || b.surname || '')).trim() || undefined;
    const name = val('eb-name'); if (name && name !== b.guest_name) body.guestName = name;
    const phone = val('eb-phone'); if (phone !== undefined && phone !== (b.guest_phone || '')) body.guestPhone = phone;
    const email = val('eb-email'); if (email !== undefined && email !== (b.guest_email || '')) body.guestEmail = email;
    const cin = val('eb-in'); const cout = val('eb-out');
    if (cin && cin !== (b.check_in || '').slice(0, 10)) body.checkIn = cin;
    if (cout && cout !== (b.check_out || '').slice(0, 10)) body.checkOut = cout;
    const adults = Number(val('eb-adults')); if (Number.isFinite(adults) && adults >= 1 && adults !== b.adults) body.adults = adults;
    const children = Number(val('eb-children')); if (Number.isFinite(children) && children >= 0 && children !== b.children) body.children = children;
    const totalEl = document.getElementById('eb-total');
    if (totalEl && !totalEl.disabled && totalEl.value !== '' && Number(totalEl.value) !== b.total_amount) body.totalAmount = Number(totalEl.value);
    const notes = val('eb-notes'); if (notes !== undefined && notes !== (b.notes || '')) body.notes = notes;

    if (Object.keys(body).length === 0) { toast('Nothing changed', 'info'); return; }
    if (body.checkIn && body.checkOut && new Date(body.checkOut) <= new Date(body.checkIn)) { toast('Check-out must be after check-in', 'error'); return; }
    try {
      await API.patch('/api/bookings/' + id, body);
      toast('Reservation updated', 'success'); closeModal(); await load();
    } catch (err) {
      if (err.status === 409) toast(err.message, 'error'); // room conflict on new dates
      else toast(err.message, 'error');
    }
  };

  // ── ROOM TRANSFER ───────────────────────────────────────────
  // Move a guest to another room (walk-in swap, maintenance move, upgrade).
  // Only rooms free for the whole stay are offered; the server re-checks inside
  // the write transaction so two desks can never double-book the same room.
  window.__transferBooking = (id) => {
    const b = state.bookings.find(x => x.id === id);
    if (!b) return;
    if (['checked_out', 'cancelled'].includes(b.status)) { toast('This booking is ' + b.status + ' and cannot be transferred', 'warn'); return; }
    const attachedIds = (b.rooms || []).map(r => r.room_id);
    // Sellable for a new stay: not occupied by an in-house guest, not on this
    // booking, and in a usable state. booking_rooms overlap re-checks dates
    // server-side, so a room booked on another confirmed reservation is still
    // selectable here and the server rejects with a readable 409 if so.
    const candidates = state.rooms.filter(r =>
      !attachedIds.includes(r.id) && ['available', 'cleaning'].includes(r.status)
    );
    openModal('🔀 Transfer Room — ' + escapeHtml(b.reference),
      '<div style="font-size:13px;line-height:1.5;margin-bottom:10px">Moving <b>' + escapeHtml(b.isGroup ? (b.group_name || b.guest_name) : b.guest_name) + '</b> (' +
        (b.rooms || []).map(r => 'Room ' + escapeHtml(r.room_number)).join(', ') + ') from <b>' + fmtDate(b.check_in) + '</b> to <b>' + fmtDate(b.check_out) + '</b>.' +
        ' Pick the new room — the guest\'s rate and folio stay attached to the reservation.</div>' +
      '<div class="form-group"><label class="form-label">Transfer to room</label>' +
        '<select class="form-input" id="tr-room">' +
          (candidates.length === 0 ? '<option value="">No other room is free for these dates</option>'
            : candidates.map(r => '<option value="' + r.id + '">Room ' + escapeHtml(r.number) + ' — ' + escapeHtml(r.type || '') + ' (' + escapeHtml(r.status) + ')</option>').join('')) +
        '</select></div>' +
      (candidates.length === 0 ? '<div style="font-size:12px;color:var(--warn);background:var(--warn-bg);border-radius:var(--radius);padding:8px 12px;margin-top:4px">⚠ Every room is either occupied, on this booking, or otherwise unavailable. Free a room first (housekeeping / check-out), then retry.</div>' : ''),
      '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
      (candidates.length === 0 ? '' : '<button class="btn primary" onclick="window.__doTransfer(\'' + b.id + '\')">Transfer Booking</button>')
    );
  };

  window.__doTransfer = async (id) => {
    const sel = document.getElementById('tr-room');
    const roomId = sel && sel.value;
    if (!roomId) { toast('Pick a room to transfer to', 'error'); return; }
    try {
      await API.post('/api/bookings/' + id + '/transfer', { roomId });
      toast('Booking transferred', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__confirmEngine = (id) => {
    confirmAction('Confirm this online booking? The room will be held for the guest.', async () => {
      try { await API.post('/api/bookings/' + id + '/confirm'); toast('Online booking confirmed', 'success'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__rejectEngine = (id) => {
    confirmAction('Reject this online booking? The guest will need to contact the hotel to rebook.', async () => {
      try { await API.post('/api/bookings/' + id + '/reject', { reason: 'rejected at front desk' }); toast('Booking rejected', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  // Facility (hall/pool) submissions are confirmed/rejected by tender code.
  window.__confirmFacility = (code) => {
    confirmAction('Confirm this online facility reservation? The slot will be held for the guest.', async () => {
      try { await API.post('/api/bookings/facilities/confirm', { code }); toast('Facility reservation confirmed', 'success'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__rejectFacility = (code) => {
    confirmAction('Reject this online facility reservation? The guest will need to contact the hotel to rebook.', async () => {
      try { await API.post('/api/bookings/facilities/reject', { code, reason: 'rejected at front desk' }); toast('Reservation rejected', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__checkinBooking = (id) => {
    confirmAction('Check in this reservation? All attached rooms will be marked occupied.', async () => {
      try {
        const bk = state.bookings.find(x => x.id === id);
        const r = await API.post('/api/bookings/' + id + '/checkin', undefined, { offline: true, label: 'Check-in — ' + (bk ? (bk.reference || bk.guest_name) : id) });
        if (r && r.__offlineQueued) {
          toast('📴 Offline — check-in saved on this device; it syncs automatically when the connection returns. Wi-Fi credentials follow after sync.', 'warn', 7000);
          return;
        }
        toast('Checked in', 'success');
        // Show Wi-Fi credentials immediately when a session was just created.
        if (r.wifi && r.wifi.identity && !r.wifi.reused) {
          setTimeout(() => window.__wifiCredentialsModal(r.wifi.sessions && r.wifi.sessions.length > 1 ? { group: r.wifi.sessions } : r.wifi), 400);
        } else if (r.wifi && r.wifi.reused) {
          toast('Wi-Fi session already active for this stay', 'info');
        }
        await load();
      }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  // Shared credential card after check-in auto-provisioning.
  // Accepts either a SINGLE session ({room, identity, password, …}) or a GROUP
  // payload ({group: [session, …]}) — one credential block per room.
  window.__wifiCredentialsModal = (w) => {
    const credCard = (s) =>
      '<div style="margin-bottom:12px">' +
        '<div style="font-family:inherit;font-size:12px;color:var(--text3);margin-bottom:4px">ROOM ' + escapeHtml(s.room || '—') + '</div>' +
        '<div style="padding:14px;background:var(--bg);font-family:monospace;font-size:15px;line-height:2">' +
          '<div>GUEST Wi-Fi</div>' +
          '<div>Network: <b>' + escapeHtml(s.identity) + '</b></div>' +
          '<div>Password: <b>' + escapeHtml(s.password || '—') + '</b></div>' +
          (s.controllerNote && !s.pushedToController ? '<div style="font-family:inherit;font-size:11px;color:var(--warn);margin-top:8px">⚠ ' + escapeHtml(s.controllerNote) + '</div>' : '') +
        '</div>' +
      '</div>';
    openModal(w.group ? 'Guest Wi-Fi — ' + w.group.length + ' Rooms' : 'Guest Wi-Fi — Room ' + escapeHtml(w.room || ''),
      (w.group ? w.group : [w]).map(credCard).join('') +
      '<p style="font-size:11px;color:var(--text3)">Guests can also self-serve at <b>/wifi.html</b> with room number + booking reference.</p>',
      '<button class="btn outline" onclick="window.print()">Print</button>' +
      '<button class="btn primary" onclick="closeModal()">Done</button>');
  };
  // Wi-Fi for an already checked-in booking (provision or fetch credentials).
  // Printable confirmation slip for online bookings (opens guest confirmation page).
  window.__engineSlip = (code) => {
    window.open('/confirmation.html?hotel=' + encodeURIComponent((window.App && App.tenant && App.tenant.subdomain) || '') + '&v=2&code=' + encodeURIComponent(code), '_blank', 'width=620,height=780');
  };

  window.__bookingWifi = async (id) => {
    try {
      const list = await API.get('/api/wifi?bookingId=' + encodeURIComponent(id));
      const actives = (Array.isArray(list) ? list : []).filter(s => s.status === 'active');
      if (actives.length > 0) {
        // Groups hold one ACTIVE session per room — show all credential cards.
        if (actives.length > 1) return window.__wifiCredentialsModal({ group: actives });
        window.__wifiDetails(actives[0].id);
      } else {
        const created = await API.post('/api/wifi', { bookingId: id });
        toast('Wi-Fi provisioned', 'success');
        // POST /api/wifi returns the primary session; pull the full per-room
        // list when the booking is a group so every room's card shows.
        try {
          const all = await API.get('/api/wifi/booking/' + encodeURIComponent(id));
          if (all && all.active && all.active.length > 1) {
            return window.__wifiCredentialsModal({ group: all.active });
          }
        } catch (e) { /* fall through to the single-session card */ }
        window.__wifiCredentialsModal({ room: created.roomNumber, identity: created.identity, password: created.password });
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__checkoutBooking = (id) => {
    confirmAction('Check out this reservation? Rooms will be sent to Housekeeping as dirty.', async () => {
      try {
        const bk = state.bookings.find(x => x.id === id);
        const r = await API.post('/api/bookings/' + id + '/checkout', undefined, { offline: true, label: 'Check-out — ' + (bk ? (bk.reference || bk.guest_name) : id) });
        if (r && r.__offlineQueued) { toast('📴 Offline — check-out saved on this device; it syncs automatically and rooms reach Housekeeping then.', 'warn', 7000); return; }
        toast('Checked out', 'success'); await load();
      }
      catch (err) {
        if (err.status === 409 && err.data && err.data.grandBalance !== undefined) {
          const canForce = typeof can === 'function' ? can('payments.manage') : false;
          openModal('Outstanding Balance',
            '<div style="background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:var(--radius);padding:14px;margin-bottom:14px">' +
              '<div style="font-weight:700;color:var(--warn)">⚠ ' + formatMoney(err.data.grandBalance) + ' outstanding</div>' +
              '<div style="font-size:12px;color:var(--text3);margin-top:4px">' + formatMoney(err.data.roomBalance) + ' room balance + ' + formatMoney(err.data.pendingTotal) + ' other unpaid charges. Settle these before checking out.</div>' +
            '</div>' +
            (canForce ? '<p style="font-size:12px;color:var(--text3)">As a manager/owner, you may override this — the balance will remain on record as unpaid.</p>' : ''),
            '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
            '<button class="btn outline" onclick="window.__goSettleBooking(\'' + id + '\')">Go to Pay</button>' +
            (canForce ? '<button class="btn danger" onclick="window.__promptOverrideReasonBooking(\'' + id + '\')">Override &amp; Check Out</button>' : '')
          );
        } else {
          toast(err.message, 'error');
        }
      }
    });
  };
  window.__goSettleBooking = (id) => {
    closeModal();
    window.__pendingSettleTarget = { bookingId: id };
    navigate('payments');
  };
  window.__promptOverrideReasonBooking = (id) => {
    openModal('Override Requires a Reason',
      '<p style="font-size:12px;color:var(--text3);margin-bottom:10px">This checkout will proceed with an outstanding balance still owed. Document why — this is recorded permanently against your name for audit purposes.</p>' +
      '<div class="form-group"><label class="form-label">Reason for Override</label><textarea class="form-input" id="ov-reason-bk" rows="3" placeholder="e.g. Corporate account will be invoiced separately; guest ID on file; manager authorized…" oninput="document.getElementById(\'ov-confirm-bk-btn\').disabled = !this.value.trim()"></textarea></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger" id="ov-confirm-bk-btn" disabled onclick="window.__forceCheckoutBooking(\'' + id + '\')">Confirm Override &amp; Check Out</button>'
    );
  };
  window.__forceCheckoutBooking = async (id) => {
    const reason = document.getElementById('ov-reason-bk').value.trim();
    if (!reason) { toast('A reason is required', 'error'); return; }
    try {
      const r = await API.post('/api/bookings/' + id + '/checkout', { forceOverride: true, overrideReason: reason }, { offline: true, label: 'Check-out (balance override)' });
      if (r && r.__offlineQueued) { toast('📴 Offline — override check-out saved; it syncs automatically when the connection returns.', 'warn', 7000); closeModal(); return; }
      toast('Checked out with an outstanding balance on record', 'warn'); closeModal(); await load();
    }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__cancelBooking = (id) => {
    confirmAction('Cancel this reservation?', async () => {
      try { await API.post('/api/bookings/' + id + '/cancel'); toast('Reservation cancelled', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
