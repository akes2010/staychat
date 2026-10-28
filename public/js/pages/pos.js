// public/js/pages/pos.js
// Point of Sale — Restaurant & Bar. Open tickets accumulate items, then get
// checked out via Cash / Card (paid immediately) or Room Charge / Customer Bill
// (posted as a pending transaction to be settled later — see Payments page).
window.PAGES = window.PAGES || {};

PAGES.pos = function () {
  const wrap = el('div', 'fa');
  const state = { outlet: 'restaurant', tickets: [], menu: [], rooms: [], guests: [], bookings: [], summary: {}, menuLoaded: false, terminal: null };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading point of sale…');
    try {
      const [tickets, summary] = await Promise.all([
        API.get('/api/pos/tickets'),
        API.get('/api/pos/summary'),
      ]);
      state.tickets = tickets;
      state.summary = summary;
      // Cashier/Barman/Server/Waiter accounts are locked to their outlet — no terminal picker, no switching.
      if (!state.terminal && App.user && (App.user.role === 'cashier' || App.user.role === 'server')) state.terminal = { outlet: 'restaurant', cashierName: App.user.name, locked: true };
      if (!state.terminal && App.user && (App.user.role === 'barman' || App.user.role === 'waiter')) state.terminal = { outlet: 'bar', cashierName: App.user.name, locked: true };
      if (state.terminal) state.outlet = state.terminal.outlet;
      if (!state.terminal) renderTerminalScreen();
      else render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'pos\')');
    }
  }

  function renderTerminalScreen() {
    const r = state.summary.restaurant || { openTickets: 0, revenueToday: 0 };
    const b = state.summary.bar || { openTickets: 0, revenueToday: 0 };
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Point of Sale</h1><p>Sign in to a terminal to start selling</p></div></div>' +
    '<div class="grid grid-2" style="max-width:640px;margin:20px auto;gap:16px">' +
      '<div class="card" style="text-align:center;padding:28px 20px;cursor:pointer" onclick="window.__posPickTerminal(\'restaurant\')">' +
        '<div style="font-size:40px;margin-bottom:10px">🍽</div><div style="font-weight:800;font-size:16px;margin-bottom:4px">Restaurant Terminal</div>' +
        '<div style="font-size:12px;color:var(--text3)">' + r.openTickets + ' open tickets &middot; ' + formatMoney(r.revenueToday) + ' today</div>' +
      '</div>' +
      '<div class="card" style="text-align:center;padding:28px 20px;cursor:pointer" onclick="window.__posPickTerminal(\'bar\')">' +
        '<div style="font-size:40px;margin-bottom:10px">🍸</div><div style="font-weight:800;font-size:16px;margin-bottom:4px">Bar Terminal</div>' +
        '<div style="font-size:12px;color:var(--text3)">' + b.openTickets + ' open tickets &middot; ' + formatMoney(b.revenueToday) + ' today</div>' +
      '</div>' +
    '</div>';
  }

  // A till operator's role pins the terminal: barman/waiter → bar,
  // cashier/server → restaurant. The server enforces the same lock
  // (server/routes/pos.js); these guards keep the console-driven UI honest too.
  function lockedOutlet() {
    if (!App.user) return null;
    if (App.user.role === 'barman' || App.user.role === 'waiter') return 'bar';
    if (App.user.role === 'cashier' || App.user.role === 'server') return 'restaurant';
    return null;
  }
  function outletName(o) { return o === 'bar' ? 'Bar' : 'Restaurant'; }

  window.__posPickTerminal = (outlet) => {
    const lock = lockedOutlet();
    if (lock && outlet !== lock) { toast('Your account is locked to the ' + outletName(lock) + ' terminal.', 'error'); return; }
    openModal((outlet === 'bar' ? '🍸 Bar' : '🍽 Restaurant') + ' Terminal Sign-In',
      '<div class="form-group"><label class="form-label">Operator Name (Cashier / Barman)</label><input class="form-input" id="pt-cashier" value="' + escapeHtml(App.user ? App.user.name : '') + '"/></div>' +
      '<p style="font-size:12px;color:var(--text3);margin-top:8px">Every ticket opened on this terminal will be attributed to this operator for shift reporting.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__posConfirmTerminal(\'' + outlet + '\')">Start Selling</button>'
    );
  };
  window.__posConfirmTerminal = (outlet) => {
    const lock = lockedOutlet();
    if (lock && outlet !== lock) { toast('Your account can only run the ' + outletName(lock) + ' terminal.', 'error'); return; }
    const cashierName = document.getElementById('pt-cashier').value.trim() || (App.user ? App.user.name : 'Operator');
    state.terminal = { outlet, cashierName };
    state.outlet = outlet;
    closeModal();
    render();
  };
  window.__posSwitchTerminal = () => {
    const lock = lockedOutlet();
    if (lock) { toast('Your account is locked to the ' + outletName(lock) + ' terminal — no switching.', 'error'); return; }
    state.terminal = null; renderTerminalScreen();
  };

  async function ensureMenuAndContext() {
    if (state.menuLoaded) return;
    const [menu, rooms, guests, bookings] = await Promise.all([API.get('/api/menu'), API.get('/api/rooms'), API.get('/api/guests'), API.get('/api/bookings?isGroup=true')]);
    state.menu = menu; state.rooms = rooms; state.guests = guests;
    state.bookings = bookings.filter(b => ['confirmed', 'checked_in'].includes(b.status));
    state.menuLoaded = true;
  }

  function render() {
    const outletTickets = state.tickets.filter(t => t.outlet === state.outlet);
    const open = outletTickets.filter(t => t.status === 'open');
    const closedToday = outletTickets.filter(t => t.status === 'closed').sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));
    const s = state.summary[state.outlet] || { openTickets: 0, revenueToday: 0, ticketsClosedToday: 0 };

    wrap.innerHTML = '' +
    '<div class="page-header">' +
      '<div class="page-header-left"><h1>Point of Sale</h1><p>' + open.length + ' open tickets &middot; ' + escapeHtml(state.outlet === 'bar' ? 'Bar' : 'Restaurant') + ' Terminal &middot; Operator: ' + escapeHtml(state.terminal ? state.terminal.cashierName : '—') + '</p></div>' +
      '<div style="display:flex;gap:10px">' + (state.terminal && state.terminal.locked ? '' : '<button class="btn outline" onclick="window.__posSwitchTerminal()">Switch Terminal</button>') + '<button class="btn primary" onclick="window.__posNewTicket()">+ New Ticket</button></div>' +
    '</div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      metricCard('Open Tickets', String(s.openTickets), null, '🧾') +
      metricCard('Revenue Today', formatMoney(s.revenueToday), null, '💰') +
      metricCard('Tickets Closed Today', String(s.ticketsClosedToday), null, '✅') +
    '</div>' +
    (open.length === 0
      ? '<div class="empty-state"><div class="empty-state-icon">' + (state.outlet === 'bar' ? '🍸' : '🍽') + '</div><div class="empty-state-title">No open ' + state.outlet + ' tickets</div><div class="empty-state-desc">Start a new ticket to begin taking orders.</div></div>'
      : '<div class="pos-board" style="margin-bottom:28px">' + open.map(ticketCardHTML).join('') + '</div>') +
    (closedToday.length > 0
      ? '<div class="card-header" style="margin-bottom:12px"><span class="card-title">Closed Today</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Ticket</th><th>Guest / Room</th><th>Items</th><th>Total</th><th>Payment</th><th>Closed</th></tr></thead><tbody>' +
        closedToday.slice(0, 15).map(t => '<tr>' +
          '<td style="font-weight:600">' + escapeHtml(t.label) + '</td>' +
          '<td>' + escapeHtml(t.guest_name || '—') + (t.room_number ? ' · Rm ' + escapeHtml(t.room_number) : '') + '</td>' +
          '<td style="font-size:12px;color:var(--text3)">' + t.items.map(i => i.qty + '× ' + i.name).join(', ') + '</td>' +
          '<td style="font-weight:700;color:var(--p)">' + formatMoney(t.total) + '</td>' +
          '<td>' + badge(paymentLabel(t.payment_method), paymentBadgeType(t.payment_method)) + '</td>' +
          '<td style="font-size:12px;color:var(--text3)">' + timeAgo(t.closed_at) + '</td>' +
        '</tr>').join('') + '</tbody></table></div>'
      : '');
  }

  function ticketCardHTML(t) {
    const count = t.items.reduce((s, i) => s + i.qty, 0);
    return '<div class="pos-ticket-card ' + t.outlet + '" onclick="window.__posOpenTicket(\'' + t.id + '\')">' +
      '<div class="pos-ticket-label">' + escapeHtml(t.label) + '</div>' +
      '<div class="pos-ticket-sub">' + escapeHtml(t.guest_name || 'Walk-in') + (t.room_number ? ' · Rm ' + escapeHtml(t.room_number) : '') + (t.covers ? ' · ' + t.covers + ' 👥' : '') + '</div>' +
      '<div class="pos-ticket-total">' + formatMoney(t.total) + '</div>' +
      '<div class="pos-ticket-meta"><span>' + count + ' item' + (count === 1 ? '' : 's') + '</span><span>' + timeAgo(t.created_at) + '</span></div>' +
    '</div>';
  }

  function paymentLabel(m) { return { cash: 'Cash', card: 'Card', room_charge: 'Room Charge', customer_bill: 'Customer Bill', group_account: 'Group Account' }[m] || m || '—'; }
  function paymentBadgeType(m) { return m === 'room_charge' ? 'info' : m === 'customer_bill' || m === 'group_account' ? 'warn' : m ? 'success' : 'default'; }

  // Outlet is locked to whichever terminal the operator signed into (see __posConfirmTerminal).

  // ── New ticket ────────────────────────────────────────────────────────
  window.__posNewTicket = async () => {
    try { await ensureMenuAndContext(); } catch (err) { toast(err.message, 'error'); return; }
    // Fresh table list per open — occupancy changes while the board is used.
    try { state.posTables = await API.get('/api/pos/tables'); } catch (e) { state.posTables = []; }
    const occupiedRooms = state.rooms.filter(r => r.status === 'occupied');
    openModal('New ' + (state.outlet === 'bar' ? 'Bar Tab' : 'Restaurant Ticket'),
      '<div style="margin-bottom:14px">' +
        (state.posTables && state.posTables.filter(x => x.location === state.outlet).length
          ? '<label class="form-label">Pick a table — seated tables are locked</label>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px" id="pos-table-chips">' +
              state.posTables.filter(x => x.location === state.outlet).map(x => {
                const open = x.occupied
                  ? '<button type="button" class="pill" data-table-id="' + x.id + '" disabled style="opacity:.45;cursor:not-allowed" title="Seated — an open ticket is already here">'
                  : '<button type="button" class="pill" data-table-id="' + x.id + '" onclick="window.__posPickTable(\'' + x.id + '\')">';
                return open +
                  escapeHtml(x.name) + ' <span style="font-size:10px;opacity:.8">' + x.persons + '👤</span>' + (x.occupied ? ' 🔒' : '');
              }).join('') +
            '</div>'
          : '<div style="font-size:12px;color:var(--text3)">No ' + (state.outlet === 'bar' ? 'bar' : 'restaurant') +
            ' tables yet — type any label below, or add tables in Tables &amp; Seating.</div>') +
        '<div class="form-group" style="margin:12px 0 0"><label class="form-label">Party Size (optional — must fit the table)</label>' +
        '<input class="form-input" type="number" min="1" max="50" step="1" id="pt-covers" placeholder="e.g. 4" style="max-width:160px"/></div>' +
      '</div>' +
      '<div class="form-row cols-2" style="margin-bottom:14px">' +
        '<div class="form-group"><label class="form-label">' + (state.outlet === 'bar' ? 'Tab Name' : 'Table') + '</label><input class="form-input" id="pt-label" placeholder="' + (state.outlet === 'bar' ? 'e.g. Bar Seat 3' : 'e.g. Table 5') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Guest Name (optional)</label><input class="form-input" id="pt-guest" placeholder="Walk-in"/></div></div>' +
      '<div class="form-group"><label class="form-label">Link to Room (optional)</label><select class="form-select" id="pt-room"><option value="">— Not linked to a room —</option>' +
        occupiedRooms.map(r => '<option value="' + escapeHtml(r.number) + '">' + escapeHtml(r.number) + ' — ' + escapeHtml(r.guest_name || 'Guest') + '</option>').join('') + '</select></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__posCreateTicket()">Open Ticket</button>'
    );
  };
  window.__posPickTable = (id) => {
    const t = (state.posTables || []).find(x => x.id === id);
    if (!t || t.occupied) return;
    const input = document.getElementById('pt-label');
    if (!input) return;
    const chips = document.querySelectorAll('#pos-table-chips .pill');
    const isSame = input.dataset.tableId === id;
    chips.forEach(c => c.classList.remove('active'));
    if (isSame) { // toggle off — back to free text
      delete input.dataset.tableId;
      input.value = '';
      return;
    }
    input.value = t.name;
    input.dataset.tableId = id;
    const chip = document.querySelector('#pos-table-chips .pill[data-table-id="' + id + '"]');
    if (chip) chip.classList.add('active');
    const covers = Number((document.getElementById('pt-covers') || {}).value || 0);
    if (covers && covers > t.persons) toast('A party of ' + covers + ' does not fit ' + t.name + ' (' + t.persons + ' persons)', 'warn');
  };

  window.__posCreateTicket = async () => {
    const label = document.getElementById('pt-label').value.trim();
    const roomNumber = document.getElementById('pt-room').value;
    const room = state.rooms.find(r => r.number === roomNumber);
    // Picker: seat only if the label still matches the picked table (the
    // operator may have typed their own label over it).
    const labelEl = document.getElementById('pt-label');
    const pickedId = labelEl && labelEl.dataset.tableId;
    const picked = pickedId ? (state.posTables || []).find(x => x.id === pickedId) : null;
    const tableId = picked && picked.name === label ? picked.id : null;
    const coversEl = document.getElementById('pt-covers');
    const covers = coversEl && coversEl.value !== '' ? Number(coversEl.value) : null;
    try {
      const ticket = await API.post('/api/pos/tickets', {
        outlet: state.outlet,
        label: label || (state.outlet === 'bar' ? 'Bar Tab' : 'Walk-in'),
        guestName: document.getElementById('pt-guest').value.trim() || (room ? room.guest_name : '') || null,
        roomNumber: roomNumber || null,
        cashierName: state.terminal ? state.terminal.cashierName : undefined,
        ...(tableId ? { tableId } : {}),
        ...(covers !== null ? { covers } : {}),
      });
      toast('Ticket opened', 'success');
      state.tickets.push(ticket);
      window.__posOpenTicket(ticket.id);
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Ticket builder modal ─────────────────────────────────────────────
  window.__posOpenTicket = async (id) => {
    try { await ensureMenuAndContext(); } catch (err) { toast(err.message, 'error'); return; }
    let ticket;
    try { ticket = await API.get('/api/pos/tickets/' + id); } catch (err) { toast(err.message, 'error'); return; }
    renderTicketModal(ticket);
  };

  let menuSearch = '';
  let menuCat = 'All';

  function renderTicketModal(ticket) {
    const items = state.menu.filter(m => m.available && (m.outlet === ticket.outlet || m.outlet === 'both' || !m.outlet));
    const cats = ['All']; items.forEach(m => { if (cats.indexOf(m.category) === -1) cats.push(m.category); });
    const filtered = items.filter(m =>
      (menuCat === 'All' || m.category === menuCat) &&
      (!menuSearch || m.name.toLowerCase().includes(menuSearch.toLowerCase()))
    );

    openModal((ticket.outlet === 'bar' ? '🍸 ' : '🍽 ') + escapeHtml(ticket.label),
      '<div class="pos-layout">' +
        '<div>' +
          '<div class="filter-pills" style="margin-bottom:8px">' + cats.map(c => '<button class="pill ' + (menuCat === c ? 'active' : '') + '" onclick="window.__posSetCat(\'' + id_(ticket) + '\',\'' + escapeJsInAttr(c) + '\')">' + escapeHtml(c) + '</button>').join('') + '</div>' +
          '<input class="form-input pos-menu-search" id="pos-menu-search" placeholder="Search menu…" value="' + escapeHtml(menuSearch) + '" oninput="window.__posSearch(\'' + id_(ticket) + '\', this.value)"/>' +
          '<div class="pos-menu-list">' +
            (filtered.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px">No items match</div>' :
            filtered.map(m => '<button class="pos-menu-item-btn" onclick="window.__posAddItem(\'' + ticket.id + '\',\'' + m.id + '\')">' +
              '<span><span class="pos-menu-item-name">' + escapeHtml(m.name) + '</span><br/><span class="pos-menu-item-cat">' + escapeHtml(m.category) + '</span></span>' +
              '<span class="pos-menu-item-price">' + formatMoney(m.price) + '</span></button>').join('')) +
          '</div>' +
        '</div>' +
        '<div id="pos-cart-panel-wrap">' + cartPanelHTML(ticket) + '</div>' +
      '</div>',
      '<button class="btn outline" style="color:var(--error)" onclick="window.__posVoidTicket(\'' + ticket.id + '\')">Void Ticket</button>' +
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      '<button class="btn primary" onclick="window.__posCheckout(\'' + ticket.id + '\')">Checkout →</button>',
      { wide: true, sub: escapeHtml(ticket.guest_name || 'Walk-in') + (ticket.room_number ? ' · Room ' + escapeHtml(ticket.room_number) : '') }
    );
  }
  function id_(t) { return t.id; }

  function cartPanelHTML(ticket) {
    const items = ticket.items;
    return '<div class="pos-cart-panel">' +
      '<div style="font-weight:700;font-size:13px;margin-bottom:10px;color:var(--text)">Ticket Items</div>' +
      (items.length === 0 ? '<div style="font-size:12px;color:var(--text3);padding:10px 0">No items yet — tap menu items to add them.</div>' :
      items.map(i => '<div class="pos-cart-line">' +
        '<div style="flex:1"><div class="pos-cart-line-name">' + escapeHtml(i.name) + '</div><div class="pos-cart-line-price">' + formatMoney(i.price) + ' each</div></div>' +
        '<div class="pos-qty-stepper">' +
          '<button class="pos-qty-btn" onclick="window.__posChangeQty(\'' + ticket.id + '\',\'' + i.id + '\',' + (i.qty - 1) + ')">−</button>' +
          '<span class="pos-qty-val">' + i.qty + '</span>' +
          '<button class="pos-qty-btn" onclick="window.__posChangeQty(\'' + ticket.id + '\',\'' + i.id + '\',' + (i.qty + 1) + ')">+</button>' +
        '</div>' +
        '<div style="font-weight:700;font-size:13px;min-width:56px;text-align:right">' + formatMoney(i.price * i.qty) + '</div>' +
      '</div>').join('')) +
      cartTotalsHTML(ticket) +
    '</div>';
  }

  function cartTotalsHTML(ticket) {
    const t = computeTotalsClient(ticket.items, ticket.discount_pct, ticket.service_pct, ticket.tax_pct);
    return '<div class="pos-cart-totals">' +
      '<div class="pos-cart-totals-row"><span>Subtotal</span><span>' + formatMoney(t.subtotal) + '</span></div>' +
      (ticket.discount_pct ? '<div class="pos-cart-totals-row"><span>Discount (' + ticket.discount_pct + '%)</span><span>−' + formatMoney(t.discountAmount) + '</span></div>' : '') +
      (ticket.service_pct ? '<div class="pos-cart-totals-row"><span>Service (' + ticket.service_pct + '%)</span><span>' + formatMoney(t.serviceAmount) + '</span></div>' : '') +
      (ticket.tax_pct ? '<div class="pos-cart-totals-row"><span>Tax (' + ticket.tax_pct + '%)</span><span>' + formatMoney(t.taxAmount) + '</span></div>' : '') +
      '<div class="pos-cart-totals-row grand"><span>Total</span><span>' + formatMoney(t.total) + '</span></div>' +
    '</div>';
  }

  function computeTotalsClient(items, discountPct, servicePct, taxPct) {
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const discountAmount = subtotal * (Number(discountPct) || 0) / 100;
    const serviceAmount = subtotal * (Number(servicePct) || 0) / 100;
    const taxableBase = subtotal - discountAmount + serviceAmount;
    const taxAmount = taxableBase * (Number(taxPct) || 0) / 100;
    return { subtotal, discountAmount, serviceAmount, taxAmount, total: taxableBase + taxAmount };
  }

  function refreshCartPanel(ticket) {
    const wrap = document.getElementById('pos-cart-panel-wrap');
    if (wrap) wrap.innerHTML = cartPanelHTML(ticket);
    // Keep the board's underlying state in sync so the ticket cards reflect the latest total.
    const idx = state.tickets.findIndex(x => x.id === ticket.id);
    if (idx > -1) state.tickets[idx] = ticket;
  }

  window.__posSetCat = async (ticketId, cat) => { menuCat = cat; const ticket = await API.get('/api/pos/tickets/' + ticketId); renderTicketModal(ticket); };
  window.__posSearch = async (ticketId, val) => { menuSearch = val; const ticket = await API.get('/api/pos/tickets/' + ticketId); renderTicketModal(ticket); document.getElementById('pos-menu-search').focus(); document.getElementById('pos-menu-search').selectionStart = document.getElementById('pos-menu-search').selectionEnd = val.length; };

  window.__posAddItem = async (ticketId, menuItemId) => {
    try {
      const ticket = await API.post('/api/pos/tickets/' + ticketId + '/items', { menuItemId, qty: 1 });
      refreshCartPanel(ticket);
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__posChangeQty = async (ticketId, itemId, newQty) => {
    try {
      const ticket = newQty <= 0
        ? await API.del('/api/pos/tickets/' + ticketId + '/items/' + itemId)
        : await API.patch('/api/pos/tickets/' + ticketId + '/items/' + itemId, { qty: newQty });
      refreshCartPanel(ticket);
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__posVoidTicket = (ticketId) => {
    confirmAction('Void this ticket? All items will be discarded and no charge will be posted.', async () => {
      try {
        await API.post('/api/pos/tickets/' + ticketId + '/void');
        toast('Ticket voided', 'warn');
        closeModal();
        await load();
      } catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Checkout ──────────────────────────────────────────────────────────
  window.__posCheckout = async (ticketId) => {
    let ticket;
    try { ticket = await API.get('/api/pos/tickets/' + ticketId); } catch (err) { toast(err.message, 'error'); return; }
    if (ticket.items.length === 0) { toast('Add at least one item before checking out', 'error'); return; }

    let method = null;
    let balanceInfo = null; // { pendingTotal, context } for the selected room/guest/group
    const occupiedRooms = state.rooms.filter(r => r.status === 'occupied');

    const renderCheckout = () => {
      const t = computeTotalsClient(ticket.items, document.getElementById('co-discount') ? Number(document.getElementById('co-discount').value || 0) : ticket.discount_pct, ticket.service_pct, ticket.tax_pct);
      const cashTendered = method === 'cash' && document.getElementById('co-cash') ? Number(document.getElementById('co-cash').value || 0) : 0;
      const change = method === 'cash' ? Math.max(0, cashTendered - t.total) : 0;
      const shortfall = method === 'cash' && cashTendered > 0 && cashTendered < t.total ? t.total - cashTendered : 0;

      openModal('Checkout — ' + escapeHtml(ticket.label),
        '<div class="pos-pay-grid" style="margin-bottom:16px">' +
          payOptionHTML('cash', '💵', 'Cash', 'Enter tendered amount') +
          payOptionHTML('card', '💳', 'Card', 'Paid in full now') +
          payOptionHTML('room_charge', '🛏', 'Room Charge', 'Post to guest folio') +
          payOptionHTML('customer_bill', '📒', 'Customer Bill', 'Bill to an account') +
          (state.bookings.length > 0 ? payOptionHTML('group_account', '👥', 'Group Account', 'Bill a group reservation') : '') +
        '</div>' +
        (method === 'cash' ?
          '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Cash Tendered</label><input class="form-input" type="number" min="0" step="0.01" id="co-cash" placeholder="Amount handed over by customer" oninput="window.__posRecalcCheckout(\'' + ticket.id + '\')"/></div>' +
          '<div id="co-change">' + changeRowHTML(cashTendered, change, shortfall, t.total) + '</div>' : '') +
        (method === 'room_charge' ?
          '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Room</label><select class="form-select" id="co-room" onchange="window.__posCheckBalance(\'' + ticket.id + '\')">' +
            '<option value="">— Select room —</option>' +
            occupiedRooms.map(r => '<option value="' + escapeHtml(r.number) + '"' + (ticket.room_number === r.number ? ' selected' : '') + '>' + escapeHtml(r.number) + ' — ' + escapeHtml(r.guest_name || 'Guest') + '</option>').join('') +
          '</select></div>' : '') +
        (method === 'customer_bill' ?
          '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Bill To</label><select class="form-select" id="co-guest" onchange="window.__posCheckBalance(\'' + ticket.id + '\')">' +
            '<option value="">— Type a name below instead —</option>' +
            state.guests.map(g => '<option value="' + g.id + '"' + (ticket.guest_id === g.id ? ' selected' : '') + '>' + escapeHtml(g.name) + (g.room_number ? ' (Rm ' + escapeHtml(g.room_number) + ')' : '') + '</option>').join('') +
          '</select>' +
          '<input class="form-input" id="co-guest-name" placeholder="Or enter a customer/company name" style="margin-top:8px" value="' + escapeHtml(ticket.guest_name || '') + '"/></div>' : '') +
        (method === 'group_account' ?
          '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Group Booking</label><select class="form-select" id="co-booking" onchange="window.__posCheckBalance(\'' + ticket.id + '\')">' +
            '<option value="">— Select group —</option>' +
            state.bookings.map(b => '<option value="' + b.id + '">' + escapeHtml(b.group_name || b.guest_name) + ' — ' + escapeHtml(b.reference) + '</option>').join('') +
          '</select></div>' : '') +
        (['room_charge', 'customer_bill', 'group_account'].includes(method) ? '<div id="co-balance">' + balanceInfoHTML(balanceInfo) + '</div>' : '') +
        '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Discount %</label><input class="form-input" type="number" min="0" max="100" step="1" id="co-discount" value="' + (ticket.discount_pct || 0) + '" oninput="window.__posRecalcCheckout(\'' + ticket.id + '\')"/></div>' +
        '<div id="co-totals">' +
          '<div class="pos-cart-totals" style="background:var(--surface2);padding:12px;border-radius:var(--radius)">' +
          '<div class="pos-cart-totals-row"><span>Subtotal</span><span>' + formatMoney(t.subtotal) + '</span></div>' +
          (t.discountAmount ? '<div class="pos-cart-totals-row"><span>Discount</span><span>−' + formatMoney(t.discountAmount) + '</span></div>' : '') +
          (t.serviceAmount ? '<div class="pos-cart-totals-row"><span>Service</span><span>' + formatMoney(t.serviceAmount) + '</span></div>' : '') +
          (t.taxAmount ? '<div class="pos-cart-totals-row"><span>Tax</span><span>' + formatMoney(t.taxAmount) + '</span></div>' : '') +
          '<div class="pos-cart-totals-row grand"><span>Total Due</span><span>' + formatMoney(t.total) + '</span></div></div>' +
        '</div>',
        '<button class="btn outline" onclick="window.__posOpenTicket(\'' + ticket.id + '\')">← Back</button>' +
        '<button class="btn primary" ' + (method ? '' : 'disabled') + ' onclick="window.__posConfirmCheckout(\'' + ticket.id + '\')">Confirm ' + (method ? paymentLabel(method) : 'Payment') + '</button>',
        { wide: true }
      );
    };

    function changeRowHTML(cashTendered, change, shortfall, total) {
      if (!cashTendered) return '<div style="font-size:12px;color:var(--text3);margin-bottom:14px">Enter the amount the customer handed over to calculate change.</div>';
      if (shortfall > 0) return '<div style="background:var(--error-bg);color:var(--error);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px;font-size:13px;font-weight:600">Short by ' + formatMoney(shortfall) + ' — total due is ' + formatMoney(total) + '</div>';
      return '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center">' +
        '<span style="font-size:13px;font-weight:600;color:var(--text2)">Change Due</span><span style="font-size:18px;font-weight:800;color:var(--a)">' + formatMoney(change) + '</span></div>';
    }

    function balanceInfoHTML(info) {
      if (!info) return '';
      if (info.pendingTotal <= 0) return '<div style="font-size:12px;color:var(--a);margin-bottom:14px">✓ No outstanding balance for ' + escapeHtml(info.context ? info.context.label : 'this account') + '.</div>';
      return '<div style="background:var(--warn-bg);border:1px solid var(--warn-border);border-radius:var(--radius);padding:10px 12px;margin-bottom:14px">' +
        '<div style="font-size:12px;font-weight:700;color:var(--warn)">⚠ Existing Balance: ' + formatMoney(info.pendingTotal) + '</div>' +
        '<div style="font-size:11px;color:var(--text3);margin-top:2px">' + escapeHtml(info.context ? info.context.label : '') + ' already has ' + info.pendingCount + ' unpaid charge' + (info.pendingCount === 1 ? '' : 's') + ' — this new charge will add to that balance.</div></div>';
    }

    function payOptionHTML(val, ico, label, desc) {
      return '<div class="pos-pay-option' + (method === val ? ' selected' : '') + '" onclick="window.__posSelectMethod(\'' + ticket.id + '\',\'' + val + '\')">' +
        '<div class="pos-pay-ico">' + ico + '</div><div class="pos-pay-label">' + label + '</div><div class="pos-pay-desc">' + desc + '</div></div>';
    }

    window.__posSelectMethod = (tid, val) => { method = val; balanceInfo = null; renderCheckout(); };
    window.__posRecalcCheckout = (tid) => {
      const discountPct = Number(document.getElementById('co-discount').value || 0);
      const t = computeTotalsClient(ticket.items, discountPct, ticket.service_pct, ticket.tax_pct);
      const totalsDiv = document.getElementById('co-totals');
      totalsDiv.innerHTML = '<div class="pos-cart-totals" style="background:var(--surface2);padding:12px;border-radius:var(--radius)">' +
        '<div class="pos-cart-totals-row"><span>Subtotal</span><span>' + formatMoney(t.subtotal) + '</span></div>' +
        (t.discountAmount ? '<div class="pos-cart-totals-row"><span>Discount</span><span>−' + formatMoney(t.discountAmount) + '</span></div>' : '') +
        (t.serviceAmount ? '<div class="pos-cart-totals-row"><span>Service</span><span>' + formatMoney(t.serviceAmount) + '</span></div>' : '') +
        (t.taxAmount ? '<div class="pos-cart-totals-row"><span>Tax</span><span>' + formatMoney(t.taxAmount) + '</span></div>' : '') +
        '<div class="pos-cart-totals-row grand"><span>Total Due</span><span>' + formatMoney(t.total) + '</span></div></div>';
      if (method === 'cash') {
        const cashTendered = Number(document.getElementById('co-cash').value || 0);
        const change = Math.max(0, cashTendered - t.total);
        const shortfall = cashTendered > 0 && cashTendered < t.total ? t.total - cashTendered : 0;
        document.getElementById('co-change').innerHTML = changeRowHTML(cashTendered, change, shortfall, t.total);
      }
    };
    window.__posCheckBalance = async (tid) => {
      let query = '';
      if (method === 'room_charge') { const v = document.getElementById('co-room').value; if (!v) return; query = 'roomNumber=' + encodeURIComponent(v); }
      if (method === 'customer_bill') { const v = document.getElementById('co-guest').value; if (!v) return; query = 'guestId=' + encodeURIComponent(v); }
      if (method === 'group_account') { const v = document.getElementById('co-booking').value; if (!v) return; query = 'bookingId=' + encodeURIComponent(v); }
      if (!query) return;
      try {
        balanceInfo = await API.get('/api/payments/balance?' + query);
        const el = document.getElementById('co-balance');
        if (el) el.innerHTML = balanceInfoHTML(balanceInfo);
      } catch (err) { /* non-critical — don't block checkout on a lookup failure */ }
    };
    window.__posConfirmCheckout = async (tid) => {
      if (!method) { toast('Choose a payment method', 'error'); return; }
      const discountPct = Number(document.getElementById('co-discount').value || 0);
      const body = { paymentMethod: method, discountPct };
      if (method === 'cash') {
        const t = computeTotalsClient(ticket.items, discountPct, ticket.service_pct, ticket.tax_pct);
        const cashTendered = Number(document.getElementById('co-cash').value || 0);
        if (cashTendered < t.total) { toast('Cash tendered is less than the total due', 'error'); return; }
      }
      if (method === 'room_charge') {
        const room = document.getElementById('co-room').value;
        if (!room) { toast('Select a room to post the charge to', 'error'); return; }
        body.roomNumber = room;
      }
      if (method === 'customer_bill') {
        const gid = document.getElementById('co-guest').value;
        const gname = document.getElementById('co-guest-name').value.trim();
        if (!gid && !gname) { toast('Select a guest or enter a customer name', 'error'); return; }
        if (gid) body.guestId = gid; else body.guestName = gname;
      }
      if (method === 'group_account') {
        const bookingId = document.getElementById('co-booking').value;
        if (!bookingId) { toast('Select a group booking to charge', 'error'); return; }
        body.bookingId = bookingId;
      }
      try {
        const result = await API.post('/api/pos/tickets/' + tid + '/checkout', body);
        let changeDue = 0;
        if (method === 'cash') {
          const cashTendered = Number(document.getElementById('co-cash').value || 0);
          changeDue = Math.max(0, cashTendered - result.ticket.total);
          toast('Paid ' + formatMoney(result.ticket.total) + ' — Change due: ' + formatMoney(changeDue), 'success');
        } else {
          toast('Ticket closed — ' + paymentLabel(method) + ' · ' + formatMoney(result.ticket.total), 'success');
        }

        const t = computeTotalsClient(ticket.items, discountPct, ticket.service_pct, ticket.tax_pct);
        showReceiptPopup({
          hotelName: (App.tenant && App.tenant.name) || 'StayChat OS',
          subtitle: (ticket.outlet === 'bar' ? 'Bar' : 'Restaurant') + ' · ' + escapeHtml(ticket.label),
          title: 'PAYMENT RECEIPT',
          defaultPaper: ticket.outlet === 'bar' ? '58mm' : '80mm',
          meta: [
            ['Date', new Date().toLocaleString()], ['Ticket', ticket.id.slice(-8).toUpperCase()],
            ['Cashier', (state.terminal && state.terminal.cashierName) || (App.user ? App.user.name : '')],
            ['Payment', paymentLabel(method)],
          ],
          lines: ticket.items.map(i => [i.name, i.qty, formatMoney(i.price * i.qty)]),
          totals: [
            ['Subtotal', formatMoney(t.subtotal)],
            ...(t.discountAmount ? [['Discount', '-' + formatMoney(t.discountAmount)]] : []),
            ...(t.serviceAmount ? [['Service', formatMoney(t.serviceAmount)]] : []),
            ...(t.taxAmount ? [['Tax', formatMoney(t.taxAmount)]] : []),
            ['TOTAL', formatMoney(t.total), true],
            ...(method === 'cash' ? [['Cash Tendered', formatMoney(Number(document.getElementById('co-cash').value || 0))], ['Change', formatMoney(changeDue)]] : []),
          ],
          footer: 'Thank you for dining with us!',
        });
        await load();
      } catch (err) { toast(err.message, 'error'); }
    };

    renderCheckout();
  };

  load();

  WSClient.on('pos.ticket.created', () => load());
  WSClient.on('pos.ticket.updated', () => load());
  WSClient.on('pos.ticket.closed', () => load());
  WSClient.on('pos.ticket.voided', () => load());

  return wrap;
};
