// public/js/pages/payments.js
window.PAGES = window.PAGES || {};

PAGES.payments = function () {
  const wrap = el('div', 'fa');
  const state = { txns: [], hotelMethods: ['cash', 'card'] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading payments…');
    try {
      const [txns, settings] = await Promise.all([API.get('/api/payments/transactions?limit=2000'), API.get('/api/settings')]);
      state.txns = txns;
      state.hotelMethods = settings.paymentMethods && settings.paymentMethods.length ? settings.paymentMethods : ['cash', 'card'];
      render();
      // If we arrived here from a checkout "Go to Payments" action, jump straight into settling that balance.
      if (window.__pendingSettleTarget) {
        const target = window.__pendingSettleTarget;
        window.__pendingSettleTarget = null;
        window.__openSettleBalance(target);
      }
    }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'payments\')'); }
  }

  function render() {
    const completed = state.txns.filter(t => t.status === 'completed');
    const total = completed.reduce((s, t) => s + t.amount, 0);
    const pending = state.txns.filter(t => t.status === 'pending');
    const txTitle = state.txns.length >= 2000 ? 'Latest 2000 Transactions' : 'All Transactions';

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Payments</h1><p>Transaction history and balance settlement</p></div>' +
      '<div style="display:flex;gap:10px"><button class="btn outline" onclick="window.__openSettleSearch()">💳 Settle a Balance</button><button class="btn primary" onclick="window.__openPaymentLink()">+ New Payment Link</button></div></div>' +
    '<div class="grid grid-4" style="margin-bottom:20px">' +
      '<div class="metric-card"><div class="metric-label">Total Revenue</div><div class="metric-value">' + formatMoney(total) + '</div><div class="metric-sub">' + completed.length + ' transactions</div></div>' +
      '<div class="metric-card" style="cursor:pointer" onclick="window.__filterPending()"><div class="metric-label">Pending</div><div class="metric-value">' + pending.length + '</div><div class="metric-sub">' + formatMoney(pending.reduce((s,t)=>s+t.amount,0)) + ' outstanding</div></div>' +
      '<div class="metric-card"><div class="metric-label">Avg Transaction</div><div class="metric-value">' + (completed.length ? formatMoney(total / completed.length) : '—') + '</div></div>' +
      '<div class="metric-card"><div class="metric-label">Accepted Methods</div><div class="metric-value" style="font-size:16px">' + state.hotelMethods.length + '</div><div class="metric-sub">Configured in Settings</div></div>' +
    '</div>' +
    '<div class="card" style="padding:0;overflow:hidden;margin-bottom:16px">' +
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--surface2)">' +
        '<span style="font-weight:700;font-size:15px">' + txTitle + '</span><button class="btn outline sm" onclick="window.__exportTransactionsCSV()">Export CSV</button></div>' +
      '<div class="table-wrap" style="border:none;border-radius:0"><table><thead><tr><th>Guest / Room</th><th>Description</th><th>Method</th><th>Amount</th><th>Status</th><th>Date</th><th>Action</th></tr></thead><tbody>' +
        (state.txns.length === 0 ? '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:30px">No transactions yet</td></tr>' : '') +
        state.txns.map(t => '<tr>' +
          '<td><div style="font-weight:600">' + escapeHtml(t.guest_name || '') + '</div><div style="font-size:11px;font-family:var(--font-mono);color:var(--text3)">' + (t.room_number ? 'Rm ' + escapeHtml(t.room_number) + ' &middot; ' : '') + escapeHtml(t.gateway_ref || '') + '</div></td>' +
          '<td style="font-size:12px">' + escapeHtml(t.description || '') + '</td><td>' + badge(t.method, 'default') + '</td><td style="font-weight:700;color:var(--p)">' + formatMoney(t.amount) + '</td><td>' + statusBadge(t.status) + '</td>' +
          '<td style="font-size:12px;color:var(--text3)">' + timeAgo(t.created_at) + '</td>' +
          '<td><div style="display:flex;gap:4px">' +
            (t.status === 'pending' ? '<button class="btn warn sm" onclick="window.__openSettleBalance({bookingId:' + (t.booking_id ? "'" + t.booking_id + "'" : 'null') + ',guestId:' + (t.guest_id ? "'" + t.guest_id + "'" : 'null') + ',roomNumber:' + (t.room_number ? "'" + t.room_number + "'" : 'null') + '})">Settle</button>' : '') +
            '<button class="btn ghost sm" onclick="window.__viewTransaction(\'' + t.id + '\')">View</button>' +
            '<button class="btn ghost sm" onclick="window.__reprintTransaction(\'' + t.id + '\')">🖨 Reprint</button>' +
          '</div></td></tr>').join('') +
      '</tbody></table></div></div>' +
    '<div class="card"><div class="card-header"><span class="card-title">Accepted Payment Methods</span></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        state.hotelMethods.map(m => badge(m.replace('_', ' '), 'success')).join('') +
      '</div><p style="font-size:11px;color:var(--text3);margin-top:10px">Configured by the owner/manager in Settings → Accepted Payment Methods.</p></div>';
  }

  // Real CSV download of the exact transactions on screen — server builds the
  // file from the same table the UI reads, so the export always matches.
  window.__exportTransactionsCSV = () => {
    window.location.href = '/api/reports/transactions/csv';
    toast('CSV export downloaded', 'success');
  };

  window.__filterPending = () => {
    // Real filter: hide completed rows in place. Click again to show all.
    const hiding = wrap.__pendingOnly = !wrap.__pendingOnly;
    wrap.querySelectorAll('tbody tr').forEach(tr => {
      const isPending = tr.querySelector('.btn.warn') !== null;
      tr.style.display = (hiding && !isPending) ? 'none' : '';
    });
    toast(hiding ? 'Showing pending only — click again to show all' : 'Showing all transactions', 'info');
  };

  // ── View transaction detail (real modal, not a toast) ──────────────────
  window.__viewTransaction = async (id) => {
    let t;
    try { t = await API.get('/api/payments/transactions/' + id); } catch (err) {
      // Offline: the warmed transactions list carries the same row.
      t = (state.txns || []).find(x => x.id === id);
      if (!t) { toast(err.message, 'error'); return; }
    }
    openModal('Transaction Detail',
      '<div style="display:flex;flex-direction:column;gap:10px;font-size:13px">' +
        '<div><strong>Status:</strong> ' + statusBadge(t.status) + '</div>' +
        '<div><strong>Guest:</strong> ' + escapeHtml(t.guest_name || '—') + (t.room_number ? ' · Room ' + escapeHtml(t.room_number) : '') + '</div>' +
        '<div><strong>Description:</strong> ' + escapeHtml(t.description || '—') + '</div>' +
        '<div><strong>Method:</strong> ' + escapeHtml(t.method) + '</div>' +
        '<div><strong>Amount:</strong> <span style="font-weight:800;color:var(--p)">' + formatMoney(t.amount) + '</span></div>' +
        '<div><strong>Reference:</strong> ' + escapeHtml(t.gateway_ref || '—') + '</div>' +
        (t.booking ? '<div><strong>Booking:</strong> ' + escapeHtml(t.booking.reference) + ' (' + escapeHtml(t.booking.status) + ')</div>' : '') +
        (t.guest ? '<div><strong>Guest Account:</strong> ' + escapeHtml(t.guest.name) + (t.guest.phone ? ' · ' + escapeHtml(t.guest.phone) : '') + '</div>' : '') +
        '<div><strong>Date:</strong> ' + new Date(t.created_at).toLocaleString() + '</div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      '<button class="btn primary" onclick="window.__reprintTransaction(\'' + t.id + '\')">🖨 Reprint Receipt</button>' +
      (t.status === 'pending' ? '<button class="btn primary" onclick="closeModal();window.__openSettleBalance({bookingId:' + (t.booking_id ? "'" + t.booking_id + "'" : 'null') + ',guestId:' + (t.guest_id ? "'" + t.guest_id + "'" : 'null') + ',roomNumber:' + (t.room_number ? "'" + t.room_number + "'" : 'null') + '})">Settle This</button>' : '')
    );
  };

  // ── Reprint any transaction: list → select → print ────────────────────
  // The exact record the server holds for that transaction, rendered as the
  // same receipt popup the settle flow uses (paper picker + Print button),
  // with the print dialog popping automatically — a reprint is a deliberate
  // "give me paper again" click.
  window.__reprintTransaction = async (id) => {
    let t;
    try { t = await API.get('/api/payments/transactions/' + id); } catch (err) {
      // Offline: reprint straight from the warmed list row.
      t = (state.txns || []).find(x => x.id === id);
      if (!t) { toast(err.message, 'error'); return; }
    }
    const receipt = {
      hotelName: (App.tenant && App.tenant.name) || 'StayChat OS',
      subtitle: t.guest_name ? (t.guest_name + (t.room_number ? ' · Room ' + t.room_number : '')) : (t.room_number ? 'Room ' + t.room_number : ''),
      title: 'PAYMENT RECEIPT' + (t.status === 'completed' ? '' : ' (' + String(t.status || '').toUpperCase() + ')'),
      defaultPaper: '210mm',
      meta: [
        ['Date', new Date(t.created_at).toLocaleString()],
        ['Method', t.method || '—'],
        ['Reference', t.gateway_ref || t.id],
        ['Status', t.status || '—'],
      ],
      lines: [[t.description || 'Payment', '', formatMoney(t.amount)]],
      totals: [['TOTAL', formatMoney(t.amount), true]],
      footer: 'Reprinted copy — original reference ' + (t.gateway_ref || t.id),
    };
    showReceiptPopup(receipt);
    setTimeout(() => {
      try {
        printReceiptWindow(receipt, receipt.defaultPaper);
        toast('Receipt sent to the printer…', 'info');
      } catch (e) { /* popup blocked — the preview's Print button still works */ }
    }, 400);
  };

  // ── Settle a balance (room + all pending charges, in one verified action) ──
  window.__openSettleSearch = () => {
    openModal('Settle a Balance',
      '<div class="form-group"><label class="form-label">Room Number</label><input class="form-input" id="ss-room" placeholder="e.g. 204"/></div>' +
      '<p style="font-size:12px;color:var(--text3)">Enter the room number to look up and settle its full outstanding balance (room charges + any POS/pool/other charges).</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__openSettleBalance({roomNumber: document.getElementById(\'ss-room\').value.trim()})">Look Up</button>'
    );
  };

  window.__openSettleBalance = async (target) => {
    if (!target || (!target.roomNumber && !target.guestId && !target.bookingId)) { toast('A room, guest, or booking is required', 'error'); return; }
    const params = new URLSearchParams();
    if (target.bookingId) params.set('bookingId', target.bookingId);
    else if (target.guestId) params.set('guestId', target.guestId);
    else params.set('roomNumber', target.roomNumber);

    let balance;
    try { balance = await API.get('/api/payments/balance?' + params.toString()); } catch (err) { toast(err.message, 'error'); return; }

    // /balance covers incidental transactions; when settling a ROOM we also
    // pull the room's own balance the way the checkout guard computes it. For
    // BOOKING/GUEST targets the endpoint now returns roomBalance directly
    // (the booking's own unpaid total), so the modal shows the SAME "Total
    // Due" the server will actually settle — previously a booking checkout
    // arrived showing only incidentals and the cash validation disagreed.
    let roomBalance = 0, roomLabel = null;
    if (target.roomNumber) {
      try {
        const rooms = await API.get('/api/rooms');
        const room = rooms.find(r => r.number === target.roomNumber);
        if (room) {
          const check = await API.get('/api/rooms/' + room.id + '/checkout-check');
          roomBalance = check.roomBalance || 0;
          roomLabel = check.guestName;
        }
      } catch (e) { /* room might not exist / not occupied — fine, just no room balance */ }
    } else if (Number(balance.roomBalance) > 0) {
      roomBalance = Number(balance.roomBalance);
    }
    const grandTotal = (roomBalance + balance.pendingTotal);
    if (grandTotal <= 0) {
      // If this lookup was triggered by "Go to Pay" from a room checkout, there's
      // nothing left to collect — finish the checkout instead of dead-ending
      // on a "no outstanding balance" toast the staff has to act on manually.
      if (target.checkoutRoomId) { await window.__finishRoomCheckoutAfterSettle(target.checkoutRoomId); return; }
      toast('No outstanding balance found for that room/guest', 'success');
      return;
    }

    renderSettleModal(target, balance, roomBalance, roomLabel, grandTotal);
  };

  // Completes the room check-out once its balance is fully settled. Used both
  // when a settle-a-balance flow started from Rooms → "Go to Pay" finishes
  // paying everything off, and when it turns out there was nothing left to
  // pay in the first place. `navigateAfter` is false when a settlement
  // receipt is still on screen — checkout happens quietly behind it instead
  // of yanking the receipt away before the staff can see/print it.
  window.__finishRoomCheckoutAfterSettle = async (roomId, navigateAfter) => {
    if (navigateAfter === undefined) navigateAfter = true;
    try {
      const r = await API.post('/api/rooms/' + roomId + '/checkout', {}, { offline: true, label: 'Room check-out' });
      if (r && r.__offlineQueued) {
        toast('📴 Offline — room check-out queued behind the payment; both sync together when the connection returns.', 'warn', 7000);
        return;
      }
      toast('Balance cleared — room checked out and marked dirty for housekeeping.', 'success');
      if (navigateAfter) navigate('rooms'); else await load();
    } catch (err) {
      toast('Balance is settled, but automatic check-out failed (' + err.message + '). Please check out the room from Rooms.', 'error');
      await load();
    }
  };

  function renderSettleModal(target, balance, roomBalance, roomLabel, grandTotal) {
    let method = null;
    // The modal is rebuilt only when the METHOD changes — never on keystrokes.
    const render = () => {
      openModal('Settle Balance — ' + escapeHtml(roomLabel || balance.context?.label || target.roomNumber || 'Guest'),
        '<div class="pos-cart-totals" style="background:var(--surface2);padding:14px;border-radius:var(--radius);margin-bottom:14px">' +
          (roomBalance > 0 ? '<div class="pos-cart-totals-row"><span>Room Balance</span><span>' + formatMoney(roomBalance) + '</span></div>' : '') +
          balance.transactions.map(t => '<div class="pos-cart-totals-row"><span>' + escapeHtml(t.description || t.method) + '</span><span>' + formatMoney(t.amount) + '</span></div>').join('') +
          '<div class="pos-cart-totals-row grand"><span>Total Due</span><span>' + formatMoney(grandTotal) + '</span></div>' +
        '</div>' +
        '<div class="pos-pay-grid" style="margin-bottom:14px">' +
          state.hotelMethods.map(m => {
            const labels = { cash: ['💵','Cash'], card: ['💳','Card'], pos: ['🏧','POS Terminal'], bank_transfer: ['🏦','Bank Transfer'], check: ['📝','Check'], crypto: ['₿','Crypto'], paypal: ['🅿️','PayPal'], payoneer: ['💠','Payoneer'], airtm: ['🌐','Airtm'], mobile_transfer: ['📱','Mobile Transfer'], offline: ['📋','Offline'] };
            const [ico, label] = labels[m] || ['💰', m];
            return '<div class="pos-pay-option' + (method === m ? ' selected' : '') + '" onclick="window.__settleSelectMethod(\'' + m + '\')"><div class="pos-pay-ico">' + ico + '</div><div class="pos-pay-label">' + label + '</div></div>';
          }).join('') +
        '</div>' +
        (method === 'cash' ? '<div class="form-group" style="margin-bottom:8px"><label class="form-label">Cash Received</label><input class="form-input" type="number" min="0" step="0.01" id="sb-cash" oninput="window.__settleRecalc()"/></div>' +
          '<div id="sb-change"></div>' : ''),
        '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" ' + (method ? '' : 'disabled') + ' onclick="window.__confirmSettle()">Confirm Settlement</button>',
        { wide: true }
      );
    };
    window.__settleSelectMethod = (m) => { method = m; render(); };
    // Keystroke handler: update ONLY the change-due box. Rewriting the whole
    // modal here (the old behavior) recreated the cash input on every
    // keystroke, wiping its value and focus — the collected amount could not
    // be typed at all.
    window.__settleRecalc = () => {
      const box = document.getElementById('sb-change');
      const input = document.getElementById('sb-cash');
      if (!box || !input) return;
      const cashReceived = Number(input.value || 0);
      const change = Math.max(0, cashReceived - grandTotal);
      const shortfall = cashReceived > 0 && cashReceived < grandTotal ? grandTotal - cashReceived : 0;
      box.innerHTML = shortfall > 0
        ? '<div style="background:var(--error-bg);color:var(--error);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px;font-size:13px;font-weight:600">Short by ' + formatMoney(shortfall) + ' — total due is ' + formatMoney(grandTotal) + '</div>'
        : (change > 0
          ? '<div style="background:var(--surface2);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px;display:flex;justify-content:space-between"><span style="font-weight:600;color:var(--text2)">Change Due</span><span style="font-weight:800;color:var(--a)">' + formatMoney(change) + '</span></div>'
          : (cashReceived > 0 ? '<div style="font-size:12px;color:var(--a);font-weight:600;padding:2px 0 10px">✓ Exact amount — no change due</div>' : ''));
    };
    window.__confirmSettle = async () => {
      const body = { method, note: '' };
      if (target.bookingId) body.bookingId = target.bookingId;
      else if (target.guestId) body.guestId = target.guestId;
      else body.roomNumber = target.roomNumber;
      if (method === 'cash') {
        const cashReceived = Number(document.getElementById('sb-cash').value || 0);
        if (cashReceived < grandTotal) { toast('Cash received must cover the full balance', 'error'); return; }
        body.cashReceived = cashReceived;
      }
      try {
        const result = await API.post('/api/payments/settle', body, { offline: true, label: 'Settlement — ' + (roomLabel || target.roomNumber || target.bookingId || 'balance') });
        if (result && result.__offlineQueued) {
          // Money was recorded on THIS device only — never fake a receipt or
          // a cleared balance. The outbox badge shows it pending; the receipt
          // prints after sync when the server has actually posted it.
          toast('📴 Offline — payment recorded on this device. It will sync automatically; the receipt prints after sync.', 'warn', 7000);
          closeModal();
          if (target.checkoutRoomId) { await window.__finishRoomCheckoutAfterSettle(target.checkoutRoomId, false); }
          return;
        }
        toast('Balance settled — ' + formatMoney(result.grandTotal) + (result.change ? ' · Change: ' + formatMoney(result.change) : ''), 'success');
        const receipt = {
          hotelName: (App.tenant && App.tenant.name) || 'StayChat OS',
          subtitle: escapeHtml(roomLabel || target.roomNumber || ''),
          title: 'SETTLEMENT RECEIPT',
          defaultPaper: '210mm',
          meta: [['Date', new Date().toLocaleString()], ['Method', method]],
          totals: [
            ...(roomBalance > 0 ? [['Room Balance', formatMoney(roomBalance)]] : []),
            ...(balance.pendingTotal > 0 ? [['Other Charges', formatMoney(balance.pendingTotal)]] : []),
            ['TOTAL SETTLED', formatMoney(result.grandTotal), true],
            ...(result.change ? [['Change Given', formatMoney(result.change)]] : []),
          ],
          footer: target.checkoutRoomId ? 'Balance cleared — checking out the room now…' : 'Balance cleared — checkout may now proceed.',
        };
        showReceiptPopup(receipt);
        // AUTO-PRINT: money just changed hands — cash, card or transfer — so
        // the browser print dialog pops immediately, no extra click. The
        // in-app preview stays open behind it; if the browser blocks the
        // popup window, its 🖨️ Print Receipt button is the manual fallback.
        setTimeout(() => {
          try {
            printReceiptWindow(receipt, receipt.defaultPaper);
            toast('Receipt sent to the printer…', 'info');
          } catch (e) { /* popup blocked — the preview's Print button still works */ }
        }, 400);
        // This settlement came from a room's "Go to Pay" checkout flow — the
        // whole point was to clear the way for checkout, so finish it now
        // instead of leaving the guest checked in and unpaid-looking again.
        // The receipt modal stays open (navigateAfter: false) so the receipt
        // that was just shown isn't yanked away before it can be printed.
        if (target.checkoutRoomId) { await window.__finishRoomCheckoutAfterSettle(target.checkoutRoomId, false); return; }
        await load();
      } catch (err) { toast(err.message, 'error'); }
    };
    render();
  }

  window.__openPaymentLink = () => {
    openModal('Create Payment Link',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Guest Name</label><input class="form-input" id="pl-name" placeholder="Guest name"/></div>' +
        '<div class="form-group"><label class="form-label">Amount ($)</label><input class="form-input" type="number" id="pl-amount" placeholder="0.00"/></div>' +
        '<div class="form-group"><label class="form-label">Room</label><input class="form-input" id="pl-room" placeholder="e.g. 204"/></div>' +
        '<div class="form-group"><label class="form-label">Method</label><select class="form-select" id="pl-gw">' + state.hotelMethods.map(m => '<option>' + m.replace('_',' ') + '</option>').join('') + '</select></div></div>' +
      '<div class="form-group" style="margin-top:12px"><label class="form-label">Description</label><input class="form-input" id="pl-desc" placeholder="e.g. Room booking, 2 nights"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn accent" onclick="window.__createPayLink()">Generate &amp; Send</button>'
    );
  };
  window.__createPayLink = async () => {
    const guestName = document.getElementById('pl-name').value;
    const amount = document.getElementById('pl-amount').value;
    if (!guestName || !amount) { toast('Name and amount required', 'error'); return; }
    try {
      const result = await API.post('/api/payments/link', {
        guestName, amount: Number(amount), roomNumber: document.getElementById('pl-room').value, description: document.getElementById('pl-desc').value, method: document.getElementById('pl-gw').value,
      });
      toast('Payment link created: ' + result.payLink, 'success', 6000);
      closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  WSClient.on('payment.created', () => load());
  return wrap;
};
