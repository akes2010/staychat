// public/js/pages/orders.js
window.PAGES = window.PAGES || {};

PAGES.orders = function () {
  const wrap = el('div', 'fa');
  const state = { orders: [], menu: [], rooms: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading orders…');
    try {
      state.orders = await API.get('/api/orders');
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'orders\')');
    }
  }

  function render() {
    const statuses = ['pending', 'preparing', 'delivered', 'cancelled'];
    const colInfo = {
      pending: { label: 'Pending', border: 'var(--warn)', bg: 'var(--warn-bg)' },
      preparing: { label: 'Preparing', border: 'var(--info)', bg: 'var(--info-bg)' },
      delivered: { label: 'Delivered', border: 'var(--success)', bg: 'var(--success-bg)' },
      cancelled: { label: 'Cancelled', border: 'var(--error)', bg: 'var(--error-bg)' },
    };
    const countOf = (s) => state.orders.filter(o => o.status === s).length;

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Room Service Orders</h1><p>' + countOf('pending') + ' pending &middot; ' + countOf('preparing') + ' preparing</p></div>' +
      '<button class="btn primary" onclick="window.__openNewOrder()">+ New Order</button></div>' +
    '<div class="grid grid-4" style="margin-bottom:20px">' +
      statuses.map(s => '<div class="card" style="border-top:3px solid ' + colInfo[s].border + '"><div style="font-size:26px;font-weight:800;color:var(--text)">' + countOf(s) + '</div><div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase">' + colInfo[s].label + '</div></div>').join('') +
    '</div>' +
    '<div class="order-board">' +
      statuses.map(status => {
        const ordersForCol = state.orders.filter(o => o.status === status);
        return '<div class="order-col"><div class="order-col-header"><span class="order-col-title">' + colInfo[status].label + '</span>' +
        '<span class="order-col-count" style="background:' + colInfo[status].bg + ';color:' + colInfo[status].border + '">' + ordersForCol.length + '</span></div>' +
        '<div class="order-items">' +
          ordersForCol.map(order => {
            const items = order.items || [];
            const itemsStr = items.map(i => i.qty + '× ' + i.name).join(', ');
            let actionsHtml = '';
            if (order.status === 'pending') actionsHtml = '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn accent sm" onclick="event.stopPropagation();window.__moveOrder(\'' + order.id + '\',\'preparing\')">Accept</button><button class="btn outline sm" onclick="event.stopPropagation();window.__moveOrder(\'' + order.id + '\',\'cancelled\')">Decline</button></div>';
            if (order.status === 'preparing') actionsHtml = '<button class="btn primary sm full" style="margin-top:10px" onclick="event.stopPropagation();window.__moveOrder(\'' + order.id + '\',\'delivered\')">Mark Delivered</button>';
            return '<div class="order-card" onclick="window.__openOrderModal(\'' + order.id + '\')">' +
              '<div class="order-room">Room ' + escapeHtml(order.room_number) + '</div><div class="order-guest">' + escapeHtml(order.guest_name || '') + '</div>' +
              '<div class="order-items-list">' + escapeHtml(itemsStr) + '</div>' +
              '<div class="order-footer"><span class="order-price">' + formatMoney(order.total) + '</span><span class="order-time">' + timeAgo(order.created_at) + '</span></div>' +
              actionsHtml + '</div>';
          }).join('') +
          (ordersForCol.length === 0 ? '<div style="text-align:center;padding:20px;color:var(--text3);font-size:13px">Empty</div>' : '') +
        '</div></div>';
      }).join('') +
    '</div>';
  }

  window.__moveOrder = async (id, newStatus) => {
    try {
      await API.patch('/api/orders/' + id + '/status', { status: newStatus });
      toast('Order ' + newStatus, newStatus === 'delivered' ? 'success' : newStatus === 'cancelled' ? 'warn' : 'info');
      await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__openOrderModal = (id) => {
    const order = state.orders.find(o => o.id === id);
    if (!order) return;
    const items = order.items || [];
    const itemsHtml = items.map(i => '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:8px"><span>' + i.qty + '× ' + escapeHtml(i.name) + '</span><span style="font-weight:600">' + formatMoney(i.price * i.qty) + '</span></div>').join('');
    openModal('Order — Room ' + escapeHtml(order.room_number),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">' +
        '<div><div style="font-size:11px;color:var(--text3);font-weight:700">ROOM</div><div style="font-size:20px;font-weight:700">' + escapeHtml(order.room_number) + '</div></div>' +
        '<div><div style="font-size:11px;color:var(--text3);font-weight:700">GUEST</div><div style="font-size:14px;font-weight:600">' + escapeHtml(order.guest_name || '') + '</div></div></div>' +
      '<div style="background:var(--surface2);border-radius:var(--radius);padding:13px;margin-bottom:16px">' + itemsHtml +
      '<div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px;display:flex;justify-content:space-between;font-weight:700;font-size:15px"><span>Total</span><span style="color:var(--p)">' + formatMoney(order.total) + '</span></div></div>' +
      (order.note ? '<div class="alert info" style="font-size:13px">Note: ' + escapeHtml(order.note) + '</div>' : '') +
      '<div class="form-group"><label class="form-label">Status</label><select class="form-select" id="order-status-sel">' + ['pending','preparing','delivered','cancelled'].map(s => '<option value="' + s + '"' + (order.status === s ? ' selected' : '') + '>' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>').join('') + '</select></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__saveOrderStatus(\'' + order.id + '\')">Update Status</button>'
    );
  };
  window.__saveOrderStatus = async (id) => {
    const ns = document.getElementById('order-status-sel').value;
    try { await API.patch('/api/orders/' + id + '/status', { status: ns }); toast('Order updated', 'success'); closeModal(); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__openNewOrder = async () => {
    try {
      const [menu, rooms] = await Promise.all([API.get('/api/menu'), API.get('/api/rooms')]);
      state.menu = menu;
      state.rooms = rooms.filter(r => r.status === 'occupied');
    } catch (err) { toast(err.message, 'error'); return; }

    let cart = [];
    openModal('New Room Service Order',
      '<div class="form-row cols-2" style="margin-bottom:16px">' +
        '<div class="form-group"><label class="form-label">Room</label><select class="form-select" id="no-room">' + state.rooms.map(r => '<option value="' + escapeHtml(r.number) + '">' + escapeHtml(r.number) + ' — ' + escapeHtml(r.guest_name || 'Guest') + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Guest Name</label><input class="form-input" id="no-guest" placeholder="Guest name"/></div></div>' +
      '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Add Items</label>' +
        '<select class="form-select" id="no-item" onchange="window.__addToCart(this.value)">' + state.menu.filter(m => m.available).map(m => '<option value="' + m.id + '">' + escapeHtml(m.name) + ' — ' + formatMoney(m.price) + '</option>').join('') + '</select></div>' +
      '<div id="cart-display" style="min-height:60px;background:var(--surface2);border-radius:var(--radius);padding:12px;font-size:13px;color:var(--text3)">Click items to add to order…</div>' +
      '<div class="form-group" style="margin-top:12px"><label class="form-label">Special Instructions</label><input class="form-input" id="no-note" placeholder="Any special requests…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__placeOrder()">Place Order</button>',
      { wide: true }
    );

    window.__addToCart = (menuId) => {
      const item = state.menu.find(m => m.id === menuId);
      if (!item) return;
      const existing = cart.find(c => c.id === menuId);
      if (existing) existing.qty++; else cart.push({ ...item, qty: 1 });
      const d = document.getElementById('cart-display');
      if (d) d.innerHTML = cart.length === 0 ? 'Click items to add…' :
        cart.map(c => '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span>' + c.qty + '× ' + escapeHtml(c.name) + '</span><span style="font-weight:700;color:var(--p)">' + formatMoney(c.price * c.qty) + '</span></div>').join('') +
        '<div style="border-top:1px solid var(--border);margin-top:8px;padding-top:8px;font-weight:700">Total: ' + formatMoney(cart.reduce((s,c) => s + c.price*c.qty, 0)) + '</div>';
    };
    window.__placeOrder = async () => {
      if (cart.length === 0) { toast('Add at least one item', 'error'); return; }
      try {
        await API.post('/api/orders', {
          roomNumber: document.getElementById('no-room').value, guestName: document.getElementById('no-guest').value || 'Guest',
          items: cart.map(c => ({ name: c.name, qty: c.qty, price: c.price })), note: document.getElementById('no-note').value,
        });
        toast('Order placed', 'success'); closeModal(); await load();
      } catch (err) { toast(err.message, 'error'); }
    };
  };

  load();

  WSClient.on('order.created', () => load());
  WSClient.on('order.updated', () => load());

  return wrap;
};
