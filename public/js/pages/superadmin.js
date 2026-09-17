// public/js/pages/superadmin.js
window.PAGES = window.PAGES || {};

PAGES.superadmin = function () {
  if (App.user.role !== 'superadmin') {
    return el('div', 'empty-state', '<div class="empty-state-icon">🚫</div><div class="empty-state-title">Access Denied</div><div class="empty-state-desc">Super Admin access required</div>');
  }
  const wrap = el('div', 'fa');
  const state = { tenants: [], overview: {}, tab: 'hotels', plans: [], gateways: [] };

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
    try { if (tab === 'gateways' && state.gateways.length === 0) state.gateways = await API.get('/api/plans/gateways'); }
    catch (err) { toast(err.message, 'error'); }
    render();
  };

  function render() {
    const o = state.overview;
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Super Admin</h1><p>Manage all hotels on the StayChat OS platform</p></div>' +
      (state.tab === 'hotels' ? '<button class="btn primary" onclick="window.__openAddTenant()">+ Onboard Hotel</button>' :
       state.tab === 'plans' ? '<button class="btn primary" onclick="window.__openAddPlan()">+ Add Plan</button>' :
       '<button class="btn primary" onclick="window.__openAddGateway()">+ Add Gateway</button>') + '</div>' +
    '<div class="grid grid-4" style="margin-bottom:20px">' +
      '<div class="metric-card"><div class="metric-label">Total Hotels</div><div class="metric-value">' + o.totalHotels + '</div><div class="metric-sub">' + o.activeHotels + ' active</div></div>' +
      '<div class="metric-card"><div class="metric-label">Monthly Revenue</div><div class="metric-value">' + formatMoney(o.totalMrr) + '</div><div class="metric-sub">MRR across all tenants</div></div>' +
      '<div class="metric-card"><div class="metric-label">Total Rooms</div><div class="metric-value">' + o.totalRooms + '</div></div>' +
      '<div class="metric-card"><div class="metric-label">Platform Status</div><div class="metric-value" style="font-size:18px">Operational</div></div>' +
    '</div>' +
    '<div class="filter-pills">' +
      '<button class="pill ' + (state.tab === 'hotels' ? 'active' : '') + '" onclick="window.__saTab(\'hotels\')">Hotels</button>' +
      '<button class="pill ' + (state.tab === 'plans' ? 'active' : '') + '" onclick="window.__saTab(\'plans\')">Subscription Plans</button>' +
      '<button class="pill ' + (state.tab === 'gateways' ? 'active' : '') + '" onclick="window.__saTab(\'gateways\')">Payment Gateways</button>' +
    '</div>' +
    (state.tab === 'hotels' ? hotelsHTML() : state.tab === 'plans' ? plansHTML() : gatewaysHTML());
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

  function plansHTML() {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">' +
      state.plans.map(p => '<div class="card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><div style="font-weight:700;font-size:15px">' + escapeHtml(p.name) + '</div>' + (p.active ? badge('Active', 'success') : badge('Inactive', 'default')) + '</div>' +
        (p.description ? '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">' + escapeHtml(p.description) + '</div>' : '') +
        '<div style="display:flex;gap:14px;margin-bottom:10px"><div><div style="font-weight:800;font-size:18px;color:var(--p)">' + formatMoney(p.price_monthly) + '</div><div style="font-size:10px;color:var(--text3)">per month</div></div>' +
          '<div><div style="font-weight:800;font-size:18px;color:var(--p)">' + formatMoney(p.price_yearly) + '</div><div style="font-size:10px;color:var(--text3)">per year</div></div></div>' +
        (p.features.length ? '<ul style="font-size:12px;color:var(--text2);padding-left:18px;margin-bottom:10px">' + p.features.map(f => '<li>' + escapeHtml(f) + '</li>').join('') + '</ul>' : '') +
        '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deletePlan(\'' + p.id + '\')">Delete</button>' +
      '</div>').join('') +
      (state.plans.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">📦</div><div class="empty-state-title">No plans yet</div></div>' : '') +
    '</div>';
  }

  function gatewaysHTML() {
    return '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Description</th><th>Status</th><th>Action</th></tr></thead><tbody>' +
      state.gateways.map(g => '<tr><td style="font-weight:600">' + escapeHtml(g.name) + '</td><td>' + badge(g.type.replace('_',' '), 'default') + '</td><td style="font-size:12px;color:var(--text3)">' + escapeHtml(g.description || '') + '</td>' +
        '<td><label class="toggle"><input type="checkbox" ' + (g.active ? 'checked' : '') + ' onchange="window.__toggleGateway(\'' + g.id + '\',this.checked)"/><span class="toggle-slider"></span></label></td>' +
        '<td><button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteGateway(\'' + g.id + '\')">Delete</button></td></tr>').join('') +
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
  window.__openAddPlan = () => {
    openModal('Add Subscription Plan',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Plan Name</label><input class="form-input" id="pl-name" placeholder="e.g. Growth"/></div>' +
        '<div class="form-group"><label class="form-label">Monthly Price ($)</label><input class="form-input" type="number" min="0" id="pl-monthly" value="0"/></div>' +
        '<div class="form-group"><label class="form-label">Yearly Price ($)</label><input class="form-input" type="number" min="0" id="pl-yearly" value="0"/></div>' +
        '<div class="form-group"><label class="form-label">Features (comma separated)</label><input class="form-input" id="pl-features" placeholder="Unlimited rooms, POS, Accounting…"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="pl-desc" placeholder="Who is this plan for?"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addPlan()">Add Plan</button>'
    );
  };
  window.__addPlan = async () => {
    const name = document.getElementById('pl-name').value.trim();
    if (!name) { toast('Plan name is required', 'error'); return; }
    try {
      await API.post('/api/plans/plans', {
        name, description: document.getElementById('pl-desc').value.trim(),
        priceMonthly: Number(document.getElementById('pl-monthly').value || 0), priceYearly: Number(document.getElementById('pl-yearly').value || 0),
        features: document.getElementById('pl-features').value.split(',').map(f => f.trim()).filter(Boolean),
      });
      toast('Plan added', 'success'); closeModal(); state.plans = await API.get('/api/plans/plans'); render();
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
