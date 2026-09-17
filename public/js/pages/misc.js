// public/js/pages/misc.js
// Other Services — shoe shine, laundry, car wash/repair, etc. Same sell →
// checkout pattern as POS, scoped down for ad-hoc hotel services.
window.PAGES = window.PAGES || {};

PAGES.misc = function () {
  const wrap = el('div', 'fa');
  const state = { services: [], orders: [], rooms: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading other services…');
    try {
      const [services, orders, rooms] = await Promise.all([API.get('/api/misc-services/services'), API.get('/api/misc-services/orders'), API.get('/api/rooms')]);
      state.services = services; state.orders = orders; state.rooms = rooms;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'misc\')'); }
  }

  function statusColor(s) { return { pending: 'warn', in_progress: 'info', completed: 'success', cancelled: 'error' }[s] || 'default'; }

  function render() {
    const active = state.orders.filter(o => o.status !== 'completed' && o.status !== 'cancelled');
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Other Services</h1><p>' + state.services.length + ' services &middot; ' + active.length + ' active orders</p></div>' +
      '<div style="display:flex;gap:10px"><button class="btn outline" onclick="window.__manageServices()">Manage Services</button><button class="btn primary" onclick="window.__openNewOrder()">+ New Order</button></div></div>' +
    (state.orders.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🧺</div><div class="empty-state-title">No orders yet</div></div>' :
    '<div class="table-wrap"><table><thead><tr><th>Service</th><th>Guest / Room</th><th>Qty</th><th>Total</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      state.orders.map(o => '<tr>' +
        '<td style="font-weight:600">' + escapeHtml(o.service_name) + '</td>' +
        '<td>' + escapeHtml(o.guest_name || 'Walk-in') + (o.room_number ? ' · Rm ' + escapeHtml(o.room_number) : '') + '</td>' +
        '<td>' + o.qty + '</td><td style="font-weight:700">' + formatMoney(o.total) + '</td>' +
        '<td>' + badge(o.status.replace('_', ' '), statusColor(o.status)) + '</td>' +
        '<td>' + (o.status === 'pending' || o.status === 'in_progress' ? '<div style="display:flex;gap:4px"><button class="btn ghost sm" onclick="window.__completeOrder(\'' + o.id + '\')">Complete</button><button class="btn ghost sm" style="color:var(--error)" onclick="window.__cancelOrder(\'' + o.id + '\')">Cancel</button></div>' : '—') + '</td>' +
      '</tr>').join('') + '</tbody></table></div>');
  }

  window.__openNewOrder = () => {
    if (state.services.length === 0) { toast('Add a service first (Manage Services)', 'error'); return; }
    const occupiedRooms = state.rooms.filter(r => r.status === 'occupied');
    openModal('New Service Order',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Service</label><select class="form-select" id="mo-service" onchange="window.__miscServicePicked()">' + state.services.filter(s => s.active).map(s => '<option value="' + s.id + '" data-price="' + s.price + '">' + escapeHtml(s.name) + ' — ' + formatMoney(s.price) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Quantity</label><input class="form-input" type="number" min="1" id="mo-qty" value="1"/></div>' +
        '<div class="form-group"><label class="form-label">Guest Name</label><input class="form-input" id="mo-guest" placeholder="Walk-in"/></div>' +
        '<div class="form-group"><label class="form-label">Room (optional)</label><select class="form-select" id="mo-room"><option value="">— Not a hotel guest —</option>' + occupiedRooms.map(r => '<option value="' + escapeHtml(r.number) + '">' + escapeHtml(r.number) + ' — ' + escapeHtml(r.guest_name || 'Guest') + '</option>').join('') + '</select></div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitOrder()">Create Order</button>'
    );
  };
  window.__miscServicePicked = () => {};
  window.__submitOrder = async () => {
    try {
      await API.post('/api/misc-services/orders', {
        serviceId: document.getElementById('mo-service').value, qty: Number(document.getElementById('mo-qty').value || 1),
        guestName: document.getElementById('mo-guest').value.trim() || 'Walk-in', roomNumber: document.getElementById('mo-room').value || null,
      });
      toast('Order created', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__completeOrder = (id) => {
    openModal('Complete Order — Select Payment',
      '<div class="pos-pay-grid">' +
        ['cash','card','room_charge','customer_bill'].map(m => '<div class="pos-pay-option" onclick="window.__finishOrder(\'' + id + '\',\'' + m + '\')"><div class="pos-pay-ico">' + ({cash:'💵',card:'💳',room_charge:'🛏',customer_bill:'📒'}[m]) + '</div><div class="pos-pay-label">' + m.replace('_',' ') + '</div></div>').join('') +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button>'
    );
  };
  window.__finishOrder = async (id, method) => {
    try { await API.post('/api/misc-services/orders/' + id + '/complete', { paymentMethod: method }); toast('Order completed', 'success'); closeModal(); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__cancelOrder = (id) => {
    confirmAction('Cancel this order?', async () => {
      try { await API.post('/api/misc-services/orders/' + id + '/cancel'); toast('Order cancelled', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Manage services catalog ──────────────────────────────────────────
  window.__manageServices = () => {
    openModal('Manage Services',
      '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">' +
        (state.services.length === 0 ? '<div style="font-size:13px;color:var(--text3)">No services yet.</div>' :
        state.services.map(s => '<div style="display:flex;align-items:center;gap:10px;background:var(--surface2);border-radius:9px;padding:10px 12px">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(s.name) + '</div><div style="font-size:11px;color:var(--text3)">' + escapeHtml(s.category) + ' &middot; ' + formatMoney(s.price) + '</div></div>' +
          (s.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteService(\'' + s.id + '\')">Delete</button></div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px">Add a Service</div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="as-name" placeholder="e.g. Shoe Shine"/></div>' +
          '<div class="form-group"><label class="form-label">Category</label><select class="form-select" id="as-category"><option>Laundry</option><option>Shoe Care</option><option>Car Service</option><option>Other</option></select></div>' +
          '<div class="form-group"><label class="form-label">Price ($)</label><input class="form-input" type="number" min="0" id="as-price" value="0"/></div>' +
        '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__addService()">Add Service</button>'
    );
  };
  window.__addService = async () => {
    const name = document.getElementById('as-name').value.trim();
    if (!name) { toast('Service name is required', 'error'); return; }
    try {
      await API.post('/api/misc-services/services', { name, category: document.getElementById('as-category').value, price: Number(document.getElementById('as-price').value || 0) });
      toast('Service added', 'success'); await load(); window.__manageServices();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteService = async (id) => {
    try { await API.del('/api/misc-services/services/' + id); toast('Service deleted', 'warn'); await load(); window.__manageServices(); }
    catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
