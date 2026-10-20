// public/js/pages/superadmin.js
window.PAGES = window.PAGES || {};

PAGES.superadmin = function () {
  if (App.user.role !== 'superadmin') {
    return el('div', 'empty-state', '<div class="empty-state-icon">🚫</div><div class="empty-state-title">Access Denied</div><div class="empty-state-desc">Super Admin access required</div>');
  }
  const wrap = el('div', 'fa');
  const state = { tenants: [], overview: {}, tab: 'hotels', plans: [], gateways: [], pending: [], platformBilling: null };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading platform data…');
    try {
      const [tenants, overview, plans] = await Promise.all([API.get('/api/superadmin/tenants'), API.get('/api/superadmin/overview'), API.get('/api/plans/plans')]);
      state.tenants = tenants; state.overview = overview; state.plans = plans;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'superadmin\')'); }
  }

  window.__saTab = async (tab) => {
    state.tab = tab;
    try {
      if (tab === 'gateways' && state.gateways.length === 0) state.gateways = await API.get('/api/plans/gateways');
      if (tab === 'billing') {
        const [pending, pb, selfhostOrders] = await Promise.all([
          API.get('/api/superadmin/subscriptions?status=pending_approval'),
          API.get('/api/superadmin/platform-billing'),
          API.get('/api/selfhost/admin/orders').catch(() => []), // Desk PC Edition
        ]);
        state.pending = pending; state.platformBilling = pb;
        state.selfhostOrders = Array.isArray(selfhostOrders) ? selfhostOrders : [];
      }
    }
    catch (err) { toast(err.message, 'error'); }
    render();
  };

  function render() {
    const o = state.overview;
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Super Admin</h1><p>Manage all hotels on the StayChat OS platform</p></div>' +
      (state.tab === 'hotels' ? '<button class="btn primary" onclick="window.__openAddTenant()">+ Onboard Hotel</button>' :
       state.tab === 'plans' ? '<button class="btn primary" onclick="window.__openAddPlan()">+ Add Plan</button>' :
       state.tab === 'billing' ? '<button class="btn outline" onclick="window.__saTab(\'billing\')">↻ Refresh</button>' :
       '<button class="btn primary" onclick="window.__openAddGateway()">+ Add Gateway</button>') + '</div>' +
    '<div class="grid grid-4" style="margin-bottom:20px">' +
      '<div class="metric-card"><div class="metric-label">Total Hotels</div><div class="metric-value">' + o.totalHotels + '</div><div class="metric-sub">' + o.activeHotels + ' active</div></div>' +
      '<div class="metric-card"><div class="metric-label">Monthly Revenue</div><div class="metric-value">' + formatMoney(o.totalMrr) + '</div><div class="metric-sub">MRR across all tenants</div></div>' +
      '<div class="metric-card"><div class="metric-label">Total Rooms</div><div class="metric-value">' + o.totalRooms + '</div></div>' +
      '<div class="metric-card"><div class="metric-label">Pending Approvals</div><div class="metric-value" style="font-size:22px;color:' + (o.pendingApprovals > 0 ? 'var(--warn,#f5a623)' : 'var(--success,#22c55e)') + '">' + o.pendingApprovals + '</div><div class="metric-sub">plan requests awaiting payment</div></div>' +
    '</div>' +
    '<div class="filter-pills">' +
      '<button class="pill ' + (state.tab === 'hotels' ? 'active' : '') + '" onclick="window.__saTab(\'hotels\')">Hotels</button>' +
      '<button class="pill ' + (state.tab === 'billing' ? 'active' : '') + '" onclick="window.__saTab(\'billing\')">Billing &amp; Approvals' + (o.pendingApprovals > 0 ? ' (' + o.pendingApprovals + ')' : '') + '</button>' +
      '<button class="pill ' + (state.tab === 'plans' ? 'active' : '') + '" onclick="window.__saTab(\'plans\')">Subscription Plans</button>' +
      '<button class="pill ' + (state.tab === 'gateways' ? 'active' : '') + '" onclick="window.__saTab(\'gateways\')">Payment Gateways</button>' +
    '</div>' +
    (state.tab === 'hotels' ? hotelsHTML() : state.tab === 'billing' ? billingHTML() : state.tab === 'plans' ? plansHTML() : gatewaysHTML());
  }

  function hotelsHTML() {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px">' +
      state.tenants.map(t => '<div class="card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
          '<div style="display:flex;align-items:center;gap:10px"><div style="width:40px;height:40px;border-radius:9px;background:linear-gradient(135deg,var(--p),var(--a));display:flex;align-items:center;justify-content:center;font-weight:800;font-size:15px;color:#fff;flex-shrink:0">' + t.name.slice(0,2) + '</div>' +
          '<div><div style="font-weight:700;font-size:14px">' + escapeHtml(t.name) + '</div><div style="font-size:11px;color:var(--text3)">' + escapeHtml(t.country || '') + ' &middot; Since ' + (t.created_at || '').slice(0,10) + '</div></div></div>' +
          statusBadge(t.status) + '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">' + [['Rooms', t.roomCount], ['MRR', formatMoney(t.mrr)], ['Plan', t.plan]].map(arr => '<div style="background:var(--surface2);border-radius:8px;padding:8px;text-align:center"><div style="font-weight:700;font-size:13px;color:var(--p)">' + arr[1] + '</div><div style="font-size:10px;color:var(--text3);font-weight:600;text-transform:uppercase">' + arr[0] + '</div></div>').join('') + '</div>' +
        (t.subscriptionStatus ? '<div style="margin-bottom:10px">' + subStatusBadge(t.subscriptionStatus) + '</div>' : '') +
        '<div style="height:1px;background:var(--border);margin-bottom:12px"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary sm" onclick="window.__switchToTenant(\'' + t.id + '\')">Manage Hotel</button><button class="btn outline sm" onclick="window.__editTenant(\'' + t.id + '\')">Edit</button>' +
          '<button class="btn outline sm" onclick="window.__manageSubscription(\'' + t.id + '\')">Subscription</button>' +
          (t.status === 'suspended' ? '<button class="btn accent sm" onclick="window.__reactivateTenant(\'' + t.id + '\')">Reactivate</button>' : '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__suspendTenant(\'' + t.id + '\')">Suspend</button>') +
        '</div></div>').join('') +
    '</div>';
  }
  function subStatusBadge(s) { return badge('Subscription: ' + s.charAt(0).toUpperCase() + s.slice(1), s === 'active' ? 'success' : s === 'suspended' ? 'warn' : 'error'); }

  // ── Billing & Approvals — the revenue control surface ──────────────────
  function billingHTML() {
    const pb = state.platformBilling || { settings: {}, autoPaymentsEnabled: false, webhookUrls: {} };
    const s = pb.settings || {};
    const stripe = s.stripe_secret_key || { set: false };
    const paystack = s.paystack_secret_key || { set: false };
    const flutterwave = s.flutterwave_secret_key || { set: false };
    const opay = s.opay_secret_key || { set: false };
    const payoneer = s.payoneer_client_secret || { set: false };
    const airtm = s.airtm_api_token || { set: false };
    const crypto = s.crypto_webhook_secret || { set: false };
    const pend = Array.isArray(state.pending) ? state.pending : [];
    return '<div style="display:grid;gap:16px">' +
      '<div class="card" style="padding:22px">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:6px">' +
          '<div><h3 style="font-size:16px">Automated payments</h3>' +
          '<div style="font-size:12.5px;color:var(--text3);margin-top:4px">Configure the PLATFORM\'s own card gateway. Hotels then get a hosted checkout link at signup/upgrade, and the gateway webhook activates their subscription automatically — no manual approval. Bank-transfer references (SC-…) keep working either way.</div></div>' +
          (pb.autoPaymentsEnabled ? badge('Auto-approvals ON', 'success') : badge('Manual approvals', 'warn')) +
        '</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:14px">' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">Stripe</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (stripe.set ? 'Configured (' + escapeHtml(stripe.hint || '') + ')' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-stripe" placeholder="sk_live_… / sk_test_…" style="margin-bottom:8px"/>' +
            '<input class="form-input" id="pb-stripe-wh" placeholder="whsec_… (webhook signing secret)"/>' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">Paystack</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (paystack.set ? 'Configured (' + escapeHtml(paystack.hint || '') + ')' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-paystack" placeholder="sk_live_… / sk_test_…" style="margin-bottom:8px"/>' +
            '<div style="font-size:11px;color:var(--text3)">Leave empty to keep the current key. Clear a field to remove that key.</div>' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">Flutterwave</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (flutterwave.set ? 'Configured (' + escapeHtml(flutterwave.hint || '') + ')' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-flutterwave" placeholder="FLWSECK-…" style="margin-bottom:8px"/>' +
            '<input class="form-input" id="pb-flutterwave-wh" placeholder="verif-hash secret"/>' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">OPay</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (opay.set ? 'Configured (' + escapeHtml(opay.hint || '') + ')' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-opay" placeholder="OPay merchant secret key" />' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">Payoneer</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (payoneer.set ? 'Configured' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-payoneer" placeholder="Payoneer client secret"/>' +
            '<div style="font-size:11px;color:var(--text3);margin-top:8px">Register the “manual settlement” webhook shown below.</div>' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">Airtm</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (airtm.set ? 'Configured' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-airtm" placeholder="Airtm API token"/>' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:12px;padding:14px">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:2px">Cryptocurrency</div>' +
            '<div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + (crypto.set ? 'Configured' : 'Not configured') + '</div>' +
            '<input class="form-input" id="pb-crypto" placeholder="Shared webhook secret (BTC/USDT rails)"/>' +
            '<div style="font-size:11px;color:var(--text3);margin-top:8px">Used to confirm on-chain transfers via the settlement webhook.</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<button class="btn primary sm" onclick="window.__savePlatformBilling()">Save gateway keys</button>' +
          '<div style="font-size:11.5px;color:var(--text3)">Webhook URLs to register with the gateway:<br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.stripe || '') + '</code><br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.paystack || '') + '</code><br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.flutterwave || '') + '</code><br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.opay || '') + '</code><br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.payoneer || '') + '</code><br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.airtm || '') + '</code><br/>' +
            '<code style="color:var(--p)">' + escapeHtml(pb.webhookUrls?.crypto || '') + '</code></div>' +
        '</div>' +
      '</div>' +
      '<div class="card" style="padding:22px">' +
        '<h3 style="font-size:16px;margin-bottom:10px">Pending plan requests (' + pend.length + ')</h3>' +
        (pend.length === 0
          ? '<div style="font-size:13px;color:var(--text3)">No pending requests. Hotels appear here when they request a paid plan with an SC- reference (or when automated checkout is unavailable).</div>'
          : '<div class="table-wrap"><table><thead><tr><th>Hotel</th><th>Plan</th><th>Cycle</th><th>Amount</th><th>Reference</th><th>Requested</th><th style="text-align:right">Action</th></tr></thead><tbody>' +
            pend.map(r => '<tr>' +
              '<td style="font-weight:600">' + escapeHtml(r.hotelName || r.tenant_id) + '</td>' +
              '<td>' + escapeHtml(r.plan_id) + '</td>' +
              '<td>' + escapeHtml(r.billing_cycle) + '</td>' +
              '<td style="font-weight:700">' + formatMoney(r.amount) + '</td>' +
              '<td><code>' + escapeHtml(r.payment_reference || '—') + '</code></td>' +
              '<td style="font-size:12px;color:var(--text3)">' + (r.requested_at || '').slice(0, 10) + '</td>' +
              '<td style="text-align:right;white-space:nowrap">' +
                '<button class="btn primary sm" onclick="window.__approveSub(\'' + r.id + '\')">Approve</button> ' +
                '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__rejectSub(\'' + r.id + '\')">Reject</button></td>' +
            '</tr>').join('') + '</tbody></table></div>') +
      '</div>' +
      deskpcOrdersHTML() +
    '</div>';
  }

  // ── Desk PC Edition orders (one-time $3,000, self-hosted) ──────────────
  // Manual bank-transfer / POS payments are confirmed here — confirming is
  // what generates the licence key and mails the installer to the customer.
  function deskpcOrdersHTML() {
    const orders = Array.isArray(state.selfhostOrders) ? state.selfhostOrders : [];
    const stBadge = s => badge(
      s === 'delivered' ? 'Delivered' : s === 'paid' ? 'Paid' :
      s === 'cancelled' ? 'Cancelled' : 'Awaiting payment',
      s === 'delivered' ? 'success' : s === 'paid' ? 'info' :
      s === 'cancelled' ? 'error' : 'warn');
    return '<div class="card" style="padding:22px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:10px">' +
        '<div><h3 style="font-size:16px">Desk PC Edition orders (' + orders.length + ')</h3>' +
        '<div style="font-size:12.5px;color:var(--text3);margin-top:4px">One-time $3,000 self-hosted purchases from the landing page. Card checkout confirms itself via the gateway webhook; confirm bank-transfer / POS payments below — confirmation generates the licence and emails the customer their installer.</div></div>' +
        '<button class="btn outline sm" onclick="window.__saTab(\'billing\')">↻ Refresh</button></div>' +
      (orders.length === 0
        ? '<div style="font-size:13px;color:var(--text3)">No registrations yet — customers appear here the moment they submit the Desk PC Edition form on the landing page.</div>'
        : '<div class="table-wrap"><table><thead><tr><th>Hotel</th><th>Contact</th><th>Amount</th><th>Reference</th><th>Status</th><th>Registered</th><th style="text-align:right">Action</th></tr></thead><tbody>' +
          orders.map(o => '<tr>' +
            '<td style="font-weight:600">' + escapeHtml(o.hotel_name || '—') + '</td>' +
            '<td style="font-size:12px">' + escapeHtml(o.name || '') + '<br><span style="color:var(--text3)">' + escapeHtml(o.email || '') + '</span></td>' +
            '<td style="font-weight:700">' + formatMoney(o.amount) + '</td>' +
            '<td><code>' + escapeHtml(o.payment_reference) + '</code></td>' +
            '<td>' + stBadge(o.status) + '</td>' +
            '<td style="font-size:12px;color:var(--text3)">' + (o.created_at || '').slice(0, 10) + '</td>' +
            '<td style="text-align:right;white-space:nowrap">' +
              (o.status === 'pending'
                ? '<button class="btn primary sm" onclick="window.__confirmSelfhost(\'' + o.payment_reference + '\')">Confirm payment</button>'
                : o.status === 'paid' || o.status === 'delivered'
                  ? '<button class="btn outline sm" onclick="window.__resendSelfhost(\'' + o.payment_reference + '\')">Resend software</button>'
                  : '<span style="font-size:12px;color:var(--text3)">—</span>') +
            '</td></tr>').join('') + '</tbody></table></div>') +
    '</div>';
  }

  window.__confirmSelfhost = (ref) => {
    confirmAction('Confirm the $3,000 payment for ' + ref + '? This issues the licence key and emails the software to the customer.', async () => {
      try {
        await API.post('/api/selfhost/admin/orders/' + encodeURIComponent(ref) + '/confirm', {});
        toast('Payment confirmed — software emailed to the customer', 'success');
        if (window.refreshSelfhostBadge) window.refreshSelfhostBadge(); // pending count dropped
        await window.__saTab('billing');
      } catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__resendSelfhost = async (ref) => {
    try {
      await API.post('/api/selfhost/admin/orders/' + encodeURIComponent(ref) + '/resend', {});
      toast('Licence + download link re-sent', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__savePlatformBilling = async () => {
    const body = {};
    const stripe = document.getElementById('pb-stripe');
    const stripeWh = document.getElementById('pb-stripe-wh');
    const paystack = document.getElementById('pb-paystack');
    const flutterwave = document.getElementById('pb-flutterwave');
    const flutterwaveWh = document.getElementById('pb-flutterwave-wh');
    const opay = document.getElementById('pb-opay');
    const payoneer = document.getElementById('pb-payoneer');
    const airtm = document.getElementById('pb-airtm');
    const crypto = document.getElementById('pb-crypto');
    if (stripe && stripe.value.trim() !== '') body.stripe_secret_key = stripe.value.trim();
    if (stripeWh && stripeWh.value.trim() !== '') body.stripe_webhook_secret = stripeWh.value.trim();
    if (paystack && paystack.value !== '') body.paystack_secret_key = paystack.value;
    if (flutterwave && flutterwave.value.trim() !== '') body.flutterwave_secret_key = flutterwave.value.trim();
    if (flutterwaveWh && flutterwaveWh.value.trim() !== '') body.flutterwave_webhook_secret = flutterwaveWh.value.trim();
    if (opay && opay.value.trim() !== '') body.opay_secret_key = opay.value.trim();
    if (payoneer && payoneer.value.trim() !== '') body.payoneer_client_secret = payoneer.value.trim();
    if (airtm && airtm.value.trim() !== '') body.airtm_api_token = airtm.value.trim();
    if (crypto && crypto.value.trim() !== '') body.crypto_webhook_secret = crypto.value.trim();
    if (Object.keys(body).length === 0) { toast('Nothing to save — enter a key first (or clear a field to remove it)', 'warn'); return; }
    try {
      await API.put('/api/superadmin/platform-billing', body);
      toast('Platform billing updated', 'success');
      await window.__saTab('billing');
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__approveSub = async (id) => {
    const gatewayRef = prompt('Gateway / transfer reference (optional):', '') || null;
    try {
      await API.post('/api/superadmin/subscriptions/' + id + '/approve', { gatewayRef });
      toast('Payment confirmed — hotel is live', 'success');
      await window.__saTab('billing');
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__rejectSub = async (id) => {
    const reason = prompt('Reason for rejecting this request (optional):', '') || null;
    try {
      await API.post('/api/superadmin/subscriptions/' + id + '/reject', { reason });
      toast('Request rejected', 'warn');
      await window.__saTab('billing');
    } catch (err) { toast(err.message, 'error'); }
  };

  function plansHTML() {
    if (state.plans.length === 0) return '<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-title">No plans yet</div><div class="empty-state-desc">Use “+ Add Plan” to build your subscription catalog.</div></div>';
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">' +
      state.plans.map(p => '<div class="card"' + (p.active ? '' : ' style="opacity:.6"') + '>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div style="font-weight:700;font-size:15px">' + escapeHtml(p.name) + '</div>' + (p.active ? badge('Active', 'success') : badge('Inactive', 'default')) + '</div>' +
        (p.description ? '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">' + escapeHtml(p.description) + '</div>' : '') +
        '<div style="display:flex;gap:14px;margin-bottom:10px"><div><div style="font-weight:800;font-size:18px;color:var(--p)">' + formatMoney(p.price_monthly) + '</div><div style="font-size:10px;color:var(--text3)">per month</div></div>' +
          '<div><div style="font-weight:800;font-size:18px;color:var(--p)">' + formatMoney(p.price_yearly) + '</div><div style="font-size:10px;color:var(--text3)">per year</div></div></div>' +
        (Array.isArray(p.features) && p.features.length ? '<ul style="font-size:12px;color:var(--text2);padding-left:18px;margin-bottom:10px">' + p.features.map(f => '<li>' + escapeHtml(f) + '</li>').join('') + '</ul>' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn outline sm" onclick="window.__openAddPlan(\'' + p.id + '\')">Edit</button>' +
          (p.active
            ? '<button class="btn ghost sm" style="color:var(--warn)" onclick="window.__togglePlan(\'' + p.id + '\',false)">Deactivate</button>'
            : '<button class="btn accent sm" onclick="window.__togglePlan(\'' + p.id + '\',true)">Activate</button>') +
          '<button class="btn ghost sm" style="color:var(--error);margin-left:auto" onclick="window.__deletePlan(\'' + p.id + '\')">Delete</button>' +
        '</div>' +
      '</div>').join('') +
    '</div>';
  }

  function gatewaysHTML() {
    return '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      state.gateways.map(g => '<tr><td style="font-weight:600">' + escapeHtml(g.name) + '</td><td>' + badge(g.type.replace('_',' '), 'default') + '</td><td style="font-size:12px;color:var(--text3)">' + escapeHtml(g.description || '') + '</td>' +
        '<td><label class="toggle"><input type="checkbox" ' + (g.active ? 'checked' : '') + ' onchange="window.__toggleGateway(\'' + g.id + '\',this.checked)"/><span class="toggle-slider"></span></label></td>' +
        '<td style="white-space:nowrap"><button class="btn outline sm" onclick="window.__openEditGateway(\'' + g.id + '\')">Edit</button> ' +
        '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteGateway(\'' + g.id + '\')">Delete</button></td></tr>').join('') +
      (state.gateways.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text3)">No gateways configured</td></tr>' : '') +
    '</tbody></table></div>';
  }

  window.__switchToTenant = (tid) => {
    const t = state.tenants.find(x => x.id === tid);
    App.tenantId = tid;
    App.tenant = t || null;
    document.getElementById('sb-user-role').textContent = t ? t.name : 'Hotel';
    toast('Switched to ' + (t ? t.name : ''), 'success');
    WSClient.reconnectWithNewTenant();
    navigate('dashboard');
  };
  window.__editTenant = (tid) => {
    const t = state.tenants.find(x => x.id === tid);
    if (!t) return;
    openModal('Edit Hotel',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Hotel Name</label><input class="form-input" id="et-name" value="' + escapeHtml(t.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Plan</label><select class="form-select" id="et-plan">' + ['starter','pro','enterprise'].map(p => '<option value="' + p + '"' + (t.plan === p ? ' selected' : '') + '>' + p.charAt(0).toUpperCase() + p.slice(1) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Contact Email</label><input class="form-input" id="et-email" value="' + escapeHtml(t.email || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Country</label><input class="form-input" id="et-country" value="' + escapeHtml(t.country || '') + '"/></div></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger sm" onclick="window.__deleteTenant(\'' + tid + '\')">Delete</button><button class="btn primary" onclick="window.__saveTenant(\'' + tid + '\')">Save</button>'
    );
  };
  window.__saveTenant = async (id) => {
    try {
      await API.patch('/api/superadmin/tenants/' + id, {
        name: document.getElementById('et-name').value, plan: document.getElementById('et-plan').value,
        email: document.getElementById('et-email').value, country: document.getElementById('et-country').value,
      });
      toast('Hotel updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteTenant = (id) => {
    confirmAction('Delete this hotel and ALL its data permanently?', async () => {
      try { await API.del('/api/superadmin/tenants/' + id); toast('Hotel deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__suspendTenant = async (id) => { try { await API.post('/api/superadmin/tenants/' + id + '/suspend', {}); toast('Hotel suspended', 'warn'); await load(); } catch (e) { toast(e.message, 'error'); } };
  window.__reactivateTenant = async (id) => { try { await API.post('/api/superadmin/tenants/' + id + '/reactivate', {}); toast('Hotel reactivated', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } };

  // ── Subscription lifecycle ───────────────────────────────────────────
  window.__manageSubscription = (tid) => {
    const t = state.tenants.find(x => x.id === tid);
    if (!t) return;
    openModal('Subscription — ' + escapeHtml(t.name),
      '<div style="margin-bottom:14px">' + subStatusBadge(t.subscriptionStatus || 'active') + (t.nextBillingDate ? ' <span style="font-size:12px;color:var(--text3)">Next billing: ' + t.nextBillingDate + '</span>' : '') + '</div>' +
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Plan</label><select class="form-select" id="sub-plan">' + state.plans.map(p => '<option value="' + p.id + '"' + (t.planId === p.id ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Billing Cycle</label><select class="form-select" id="sub-cycle"><option value="monthly"' + (t.billingCycle !== 'yearly' ? ' selected' : '') + '>Monthly</option><option value="yearly"' + (t.billingCycle === 'yearly' ? ' selected' : '') + '>Yearly</option></select></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        '<button class="btn primary sm" onclick="window.__subAction(\'' + tid + '\',\'assign\')">Assign / Change Plan</button>' +
        '<button class="btn outline sm" onclick="window.__subAction(\'' + tid + '\',\'upgrade\')">Upgrade</button>' +
        '<button class="btn outline sm" onclick="window.__subAction(\'' + tid + '\',\'downgrade\')">Downgrade</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;padding-top:10px;border-top:1px solid var(--border)">' +
        '<button class="btn ghost sm" style="color:var(--warn)" onclick="window.__subAction(\'' + tid + '\',\'suspend\')">Suspend Subscription</button>' +
        '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__subAction(\'' + tid + '\',\'terminate\')">Terminate</button>' +
        '<button class="btn ghost sm" style="color:var(--a)" onclick="window.__subAction(\'' + tid + '\',\'reactivate\')">Reactivate</button>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>'
    );
  };
  window.__subAction = async (tid, action) => {
    try {
      await API.post('/api/plans/tenants/' + tid + '/subscription', { action, planId: document.getElementById('sub-plan') ? document.getElementById('sub-plan').value : undefined, billingCycle: document.getElementById('sub-cycle') ? document.getElementById('sub-cycle').value : undefined });
      toast('Subscription updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Plans ────────────────────────────────────────────────────────────
  // One modal serves BOTH create and edit — the server's POST /plans and
  // PATCH /plans/:id cover the whole lifecycle; the missing piece was UI.
  window.__openAddPlan = (planId) => {
    const p = planId ? state.plans.find(x => x.id === planId) : null;
    openModal(p ? 'Edit Plan — ' + escapeHtml(p.name) : 'Add Subscription Plan',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Plan Name</label><input class="form-input" id="pl-name" placeholder="e.g. Growth" value="' + escapeHtml(p ? p.name : '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Monthly Price ($)</label><input class="form-input" type="number" min="0" id="pl-monthly" value="' + (p ? p.price_monthly : 0) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Yearly Price ($)</label><input class="form-input" type="number" min="0" id="pl-yearly" value="' + (p ? p.price_yearly : 0) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Features (comma separated)</label><input class="form-input" id="pl-features" placeholder="Unlimited rooms, POS, Accounting…" value="' + escapeHtml(p && Array.isArray(p.features) ? p.features.join(', ') : '') + '"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="pl-desc" placeholder="Who is this plan for?" value="' + escapeHtml(p ? (p.description || '') : '') + '"/></div>' +
      (p ? '<div class="toggle-wrap"><div class="toggle-info"><div class="toggle-label">Active</div><div class="toggle-desc">Inactive plans stay in the database but cannot be assigned to hotels.</div></div><label class="toggle"><input type="checkbox" id="pl-active"' + (p.active ? ' checked' : '') + '/><span class="toggle-slider"></span></label></div>' : ''),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__savePlan(' + (planId ? '\'' + planId + '\'' : '') + ')">' + (p ? 'Save Changes' : 'Add Plan') + '</button>'
    );
  };
  window.__savePlan = async (planId) => {
    const name = document.getElementById('pl-name').value.trim();
    if (!name) { toast('Plan name is required', 'error'); return; }
    const body = {
      name, description: document.getElementById('pl-desc').value.trim(),
      priceMonthly: Number(document.getElementById('pl-monthly').value || 0), priceYearly: Number(document.getElementById('pl-yearly').value || 0),
      features: document.getElementById('pl-features').value.split(',').map(f => f.trim()).filter(Boolean),
    };
    const activeEl = document.getElementById('pl-active');
    if (activeEl) body.active = activeEl.checked;
    try {
      if (planId) { await API.patch('/api/plans/plans/' + planId, body); toast('Plan updated', 'success'); }
      else { await API.post('/api/plans/plans', body); toast('Plan added', 'success'); }
      closeModal(); state.plans = await API.get('/api/plans/plans'); render();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__togglePlan = async (id, val) => {
    try {
      await API.patch('/api/plans/plans/' + id, { active: val });
      toast(val ? 'Plan activated' : 'Plan deactivated', val ? 'success' : 'warn');
      state.plans = await API.get('/api/plans/plans'); render();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deletePlan = (id) => {
    confirmAction('Delete this plan?', async () => {
      try { await API.del('/api/plans/plans/' + id); toast('Plan deleted', 'warn'); state.plans = await API.get('/api/plans/plans'); render(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Payment Gateways ─────────────────────────────────────────────────
  window.__openAddGateway = () => {
    openModal('Add Payment Gateway',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="gw-name" placeholder="e.g. Flutterwave Bank Transfer"/></div>' +
        '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="gw-type">' +
          ['bank_transfer','pos','crypto','paypal','payoneer','airtm','card','other'].map(t => '<option value="' + t + '">' + t.replace('_',' ') + '</option>').join('') +
        '</select></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="gw-desc" placeholder="Notes for hotels using this gateway…"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addGateway()">Add Gateway</button>'
    );
  };
  window.__addGateway = async () => {
    const name = document.getElementById('gw-name').value.trim();
    if (!name) { toast('Gateway name is required', 'error'); return; }
    try {
      await API.post('/api/plans/gateways', { name, type: document.getElementById('gw-type').value, description: document.getElementById('gw-desc').value.trim() });
      toast('Gateway added', 'success'); closeModal(); state.gateways = await API.get('/api/plans/gateways'); render();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__toggleGateway = async (id, val) => {
    try { await API.patch('/api/plans/gateways/' + id, { active: val }); state.gateways = await API.get('/api/plans/gateways'); render(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteGateway = (id) => {
    confirmAction('Delete this gateway?', async () => {
      try { await API.del('/api/plans/gateways/' + id); toast('Gateway deleted', 'warn'); state.gateways = await API.get('/api/plans/gateways'); render(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__openEditGateway = (id) => {
    const g = state.gateways.find(x => x.id === id);
    if (!g) return;
    openModal('Edit Gateway — ' + escapeHtml(g.name),
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="gw-name" value="' + escapeHtml(g.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="gw-type">' +
          ['bank_transfer','pos','crypto','paypal','payoneer','airtm','card','other'].map(t => '<option value="' + t + '"' + (g.type === t ? ' selected' : '') + '>' + t.replace('_',' ') + '</option>').join('') +
        '</select></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="gw-desc" value="' + escapeHtml(g.description || '') + '"/></div>' +
      '<div class="toggle-wrap"><div class="toggle-info"><div class="toggle-label">Active</div><div class="toggle-desc">Off = hidden from the payment options hotels see.</div></div><label class="toggle"><input type="checkbox" id="gw-active"' + (g.active ? ' checked' : '') + '/><span class="toggle-slider"></span></label></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveGateway(\'' + id + '\')">Save Changes</button>'
    );
  };
  window.__saveGateway = async (id) => {
    const name = document.getElementById('gw-name').value.trim();
    if (!name) { toast('Gateway name is required', 'error'); return; }
    try {
      await API.patch('/api/plans/gateways/' + id, {
        name, type: document.getElementById('gw-type').value,
        description: document.getElementById('gw-desc').value.trim(),
        active: document.getElementById('gw-active').checked,
      });
      toast('Gateway updated', 'success'); closeModal();
      state.gateways = await API.get('/api/plans/gateways'); render();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__openAddTenant = () => {
    openModal('Onboard New Hotel',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Hotel Name</label><input class="form-input" id="at-name" placeholder="e.g. Blue Ocean Hotel"/></div>' +
        '<div class="form-group"><label class="form-label">Plan</label><select class="form-select" id="at-plan"><option value="starter">Starter</option><option value="pro" selected>Pro</option><option value="enterprise">Enterprise</option></select></div>' +
        '<div class="form-group"><label class="form-label">Admin Email</label><input class="form-input" type="email" id="at-email" placeholder="admin@hotel.com"/></div>' +
        '<div class="form-group"><label class="form-label">Country</label><input class="form-input" id="at-country" placeholder="e.g. Nigeria"/></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">Subdomain</label><div class="input-group"><span class="input-group-prefix">https://</span><input class="form-input" id="at-sub" placeholder="hotel-name" style="border:none;border-radius:0"/><span class="input-group-prefix">.staychat.io</span></div></div></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addTenant()">Onboard Hotel</button>', { wide: true }
    );
  };
  window.__addTenant = async () => {
    const name = document.getElementById('at-name').value.trim();
    if (!name) { toast('Hotel name required', 'error'); return; }
    try {
      const result = await API.post('/api/superadmin/tenants', {
        name, plan: document.getElementById('at-plan').value, email: document.getElementById('at-email').value,
        country: document.getElementById('at-country').value, subdomain: document.getElementById('at-sub').value,
      });
      if (result.tempPassword) toast(name + ' onboarded! Admin login: ' + result.adminEmail + ' / ' + result.tempPassword, 'success', 8000);
      else toast(name + ' onboarded successfully!', 'success');
      closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
