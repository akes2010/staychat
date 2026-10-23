// public/js/pages/fitness-memberships.js
// Gym & Pool memberships — quarterly registrations and combined Gym & Pool
// membership plans (month / quarter / year pricing, features and benefits).
//
// Additive module, same injection pattern as menu-categories.js: a Mutation-
// Observer watches the Gym & Fitness and Pool Bookings pages and injects a
// "🤝 Gym & Pool" button into their headers. Nothing in gym.js, pool.js or
// any other system file is modified — the button simply opens this module's
// own modal, which talks to the new /api/fitness endpoints.
window.PAGES = window.PAGES || {};

(function () {
  const DURATIONS = [
    { key: 'daily', label: 'Daily' },
    { key: 'monthly', label: 'Monthly' },
    { key: 'quarterly', label: 'Quarterly' },
    { key: 'yearly', label: 'Yearly' },
  ];
  const SCOPE_BADGES = { gym: 'info', pool: 'success', both: 'info' };
  const SCOPE_LABELS = { gym: 'Gym', pool: 'Pool', both: 'Gym & Pool' };

  const state = { plans: [], memberships: [], selectedPlan: null, duration: 'monthly' };

  function canManage() { return typeof can === 'function' ? (can('gym.manage') || can('pool.manage')) : true; }
  function canUse() { return typeof can === 'function' ? (can('gym.use') || can('pool.use')) : true; }
  function durLabel(d) { const x = DURATIONS.find(y => y.key === d); return x ? x.label : d; }

  // Same calendar math as the server: +N months − 1 day, inclusive.
  function periodEnd(duration, start) {
    if (duration === 'daily') return start;
    const months = { monthly: 1, quarterly: 3, yearly: 12 }[duration] || 1;
    const d = new Date(start + 'T00:00:00Z');
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last) - 1);
    return d.toISOString().slice(0, 10);
  }

  // ── Header injection (Gym & Fitness / Pool Bookings) ──────────────────
  function injectButton() {
    if (!canUse()) return;
    const header = document.querySelector('#content .page-header');
    if (!header) return;
    const h1 = header.querySelector('h1');
    if (!h1) return;
    const title = h1.textContent.trim();
    if (title !== 'Gym & Fitness' && title !== 'Pool Bookings') return;
    if (header.querySelector('#fm-open-btn')) return;
    // The pages render their action buttons in the header's last flex div.
    const actions = header.lastElementChild;
    if (!actions || actions === header.firstElementChild) return;
    const btn = document.createElement('button');
    btn.id = 'fm-open-btn';
    btn.className = 'btn outline';
    btn.textContent = '🤝 Gym & Pool';
    btn.title = 'Gym & Pool memberships — monthly, quarterly & yearly';
    btn.onclick = () => window.__fmOpen();
    actions.insertBefore(btn, actions.firstChild);
  }

  function startObserver() {
    const content = document.getElementById('content');
    if (!content) return;
    const mo = new MutationObserver(() => { try { injectButton(); } catch (e) { /* never break the host page */ } });
    mo.observe(content, { childList: true, subtree: true });
    try { injectButton(); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver);
  else startObserver();

  // ── Main modal ────────────────────────────────────────────────────────
  async function load() {
    const [plans, memberships] = await Promise.all([
      API.get('/api/fitness/plans'),
      API.get('/api/fitness/memberships'),
    ]);
    state.plans = plans;
    state.memberships = memberships;
  }

  function planCardHTML(p) {
    const selected = state.selectedPlan && state.selectedPlan.id === p.id;
    return '<div class="fm-plan-card' + (selected ? ' selected' : '') + (!p.active ? ' fm-plan-inactive' : '') + '" id="fm-plan-' + p.id + '" data-plan-id="' + p.id + '">' +
      '<div class="fm-plan-head">' +
        '<span class="fm-plan-name">' + escapeHtml(p.name) + '</span>' +
        badge(SCOPE_LABELS[p.scope] || p.scope, SCOPE_BADGES[p.scope] || 'default') +
        (p.active ? '' : badge('Inactive', 'default')) +
      '</div>' +
      '<div class="fm-plan-prices">' +
        '<span class="fm-price-chip"><b>' + formatMoney(p.price_daily) + '</b>/day</span>' +
        '<span class="fm-price-chip"><b>' + formatMoney(p.price_monthly) + '</b>/mo</span>' +
        '<span class="fm-price-chip highlight"><b>' + formatMoney(p.price_quarterly) + '</b>/qtr</span>' +
        '<span class="fm-price-chip"><b>' + formatMoney(p.price_yearly) + '</b>/yr</span>' +
      '</div>' +
      (p.features.length ? '<ul class="fm-plan-list">' + p.features.map(f => '<li>' + escapeHtml(f) + '</li>').join('') + '</ul>' : '') +
      (p.benefits.length ? '<div class="fm-plan-benefits"><div class="fm-plan-benefits-title">Member benefits</div>' + p.benefits.map(b => '<span class="fm-benefit-chip">' + escapeHtml(b) + '</span>').join('') + '</div>' : '') +
      (p.active
        ? '<button class="btn ' + (selected ? 'primary' : 'outline') + ' sm fm-choose-btn" onclick="window.__fmSelectPlan(\'' + p.id + '\')">' + (selected ? '✓ Selected' : 'Choose') + '</button>'
        : '<div class="fm-plan-paused">Not accepting registrations</div>') +
    '</div>';
  }

  function registrationFormHTML() {
    const p = state.selectedPlan;
    if (!p) return '<div class="fm-form-hint">Pick a plan above to register a member — monthly, quarterly or yearly.</div>';
    const price = Number(p['price_' + state.duration]) || 0;
    return '<div class="fm-form-box" id="fm-form">' +
      '<div class="fm-form-title">Register on “' + escapeHtml(p.name) + '”</div>' +
      '<div class="fm-dur-row">' +
        DURATIONS.map(d => '<button type="button" class="fm-dur-btn' + (state.duration === d.key ? ' active' : '') + '" data-duration="' + d.key + '" onclick="window.__fmSetDuration(\'' + d.key + '\')">' +
          d.label + '<span class="fm-dur-price">' + formatMoney(Number(p['price_' + d.key]) || 0) + '</span></button>').join('') +
      '</div>' +
      '<div class="fm-summary" id="fm-summary"></div>' +
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Member Name</label><input class="form-input" id="fm-name" placeholder="Full name"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="fm-phone" placeholder="+234…"/></div>' +
        '<div class="form-group"><label class="form-label">Email (optional)</label><input class="form-input" type="email" id="fm-email" placeholder="member@email.com"/></div>' +
        '<div class="form-group"><label class="form-label">Room Number (optional)</label><input class="form-input" id="fm-room" placeholder="e.g. 204"/></div>' +
        '<div class="form-group"><label class="form-label">Start Date</label><input class="form-input" type="date" id="fm-start" value="' + new Date().toISOString().slice(0, 10) + '" onchange="window.__fmRefreshSummary()"/></div>' +
        (canManage() ? '<div class="form-group"><label class="form-label">Amount ($)</label><input class="form-input" type="number" min="0" id="fm-amount" value="' + price + '"/></div>' : '') +
        (canManage() ? '<div class="form-group"><label class="form-label">Paid</label><select class="form-select" id="fm-paid"><option value="false">No</option><option value="true">Yes</option></select></div>' : '') +
      '</div>' +
      '<div class="form-group"><label class="form-label">Notes</label><input class="form-input" id="fm-notes" placeholder="Optional notes…"/></div>' +
    '</div>';
  }

  function membershipsListHTML() {
    const active = state.memberships.filter(m => m.status === 'active');
    if (active.length === 0) return '<div class="fm-list-empty">No active combined memberships yet.</div>';
    return active.map(m => {
      const plan = state.plans.find(p => p.id === m.plan_id);
      return '<div class="fm-member-row">' +
      '<div class="fm-member-main">' +
        '<div class="fm-member-name">' + escapeHtml(m.member_name) + ' ' + badge(durLabel(m.duration), 'info') + badge(SCOPE_LABELS[m.scope] || m.scope, SCOPE_BADGES[m.scope] || 'default') + (m.paid ? badge('Paid', 'success') : badge('Unpaid', 'warn')) + '</div>' +
        '<div class="fm-member-sub">' + escapeHtml(plan ? plan.name : 'Plan') + ' &middot; ' + escapeHtml(m.start_date) + ' – ' + escapeHtml(m.end_date) + (m.member_phone ? ' &middot; ' + escapeHtml(m.member_phone) : '') + (m.room_number ? ' &middot; Room ' + escapeHtml(m.room_number) : '') + '</div>' +
      '</div>' +
      '<div class="fm-member-amount">' + formatMoney(m.amount) + '</div>' +
      '<div class="fm-member-actions">' +
        '<button class="btn ghost sm" id="fm-complete-' + m.id + '" onclick="window.__fmAction(\'' + m.id + '\',\'complete\')">Complete</button>' +
        (canManage() ? '<button class="btn ghost sm" style="color:var(--error)" id="fm-cancel-' + m.id + '" onclick="window.__fmAction(\'' + m.id + '\',\'cancel\')">Cancel</button>' : '') +
      '</div>' +
      '</div>';
    }).join('');
  }

  function bodyHTML() {
    const activePlans = state.plans.filter(p => p.active);
    return '<div class="fm-plans-wrap" id="fm-plans">' +
        (state.plans.length === 0
          ? '<div class="fm-empty">' +
              '<div class="fm-empty-title">No membership plans yet</div>' +
              '<div class="fm-empty-desc">Plans combine gym &amp; pool access with month, quarter and year pricing, plus features &amp; benefits.</div>' +
              (canManage() ? '<button class="btn primary" style="margin-top:10px" id="fm-first-plan-btn" onclick="window.__fmManagePlans()">Create the first plan</button>'
                            : '<div class="fm-empty-desc">Ask a manager to create the first plan.</div>') +
            '</div>'
          : '<div class="fm-plan-grid">' + state.plans.map(planCardHTML).join('') + '</div>') +
      '</div>' +
      (activePlans.length > 0 || state.selectedPlan ? registrationFormHTML() : '') +
      '<div class="fm-section-title">Active memberships</div>' +
      '<div id="fm-list">' + membershipsListHTML() + '</div>';
  }

  window.__fmOpen = async () => {
    if (!canUse()) { toast('You don\'t have permission to manage memberships', 'error'); return; }
    openModal('🤝 Gym & Pool Memberships',
      '<div id="fm-modal-body"><div style="font-size:13px;color:var(--text3);padding:12px 0">Loading plans…</div></div>',
      '<button class="btn outline" id="fm-manage-btn" onclick="window.__fmManagePlans()"' + (canManage() ? '' : ' style="display:none"') + '>Manage Plans</button>' +
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      '<button class="btn primary" id="fm-register-btn" onclick="window.__fmSubmit()">Register Member</button>',
      { wide: true, sub: 'Monthly · Quarterly · Yearly — gym only, pool only or combined' });
    try {
      await load();
      // Keep the picked plan in sync with the freshly loaded rows.
      if (state.selectedPlan) {
        const fresh = state.plans.find(p => p.id === state.selectedPlan.id);
        state.selectedPlan = fresh || null;
      }
      document.getElementById('fm-modal-body').innerHTML = bodyHTML();
      window.__fmRefreshSummary();
    } catch (err) {
      document.getElementById('fm-modal-body').innerHTML = '<div class="fm-empty"><div class="fm-empty-title">Could not load plans</div><div class="fm-empty-desc">' + escapeHtml(err.message) + '</div></div>';
    }
  };

  window.__fmSelectPlan = (id) => {
    const p = state.plans.find(x => x.id === id);
    if (!p || !p.active) return;
    state.selectedPlan = p;
    document.getElementById('fm-modal-body').innerHTML = bodyHTML();
    window.__fmRefreshSummary();
  };

  window.__fmSetDuration = (d) => {
    state.duration = d;
    document.querySelectorAll('.fm-dur-btn').forEach(b => b.classList.toggle('active', b.dataset.duration === d));
    const amountEl = document.getElementById('fm-amount');
    if (amountEl && state.selectedPlan) amountEl.value = Number(state.selectedPlan['price_' + d]) || 0;
    window.__fmRefreshSummary();
  };

  window.__fmRefreshSummary = () => {
    const el2 = document.getElementById('fm-summary');
    if (!el2 || !state.selectedPlan) return;
    const start = (document.getElementById('fm-start') || {}).value || new Date().toISOString().slice(0, 10);
    const end = periodEnd(state.duration, start);
    const p = state.selectedPlan;
    const included = (p.features || []).slice(0, 4).map(f => escapeHtml(f)).join(' · ');
    el2.innerHTML = '<div class="fm-summary-line"><b>' + durLabel(state.duration) + '</b> membership &middot; ' + escapeHtml(start) + ' → ' + escapeHtml(end) +
      ' &middot; <b>' + formatMoney(Number(p['price_' + state.duration]) || 0) + '</b></div>' +
      (included ? '<div class="fm-summary-feats">' + included + ((p.features || []).length > 4 ? ' …' : '') + '</div>' : '');
  };

  window.__fmSubmit = async () => {
    if (!state.selectedPlan) { toast('Choose a plan first', 'error'); return; }
    const memberName = document.getElementById('fm-name').value.trim();
    const startDate = document.getElementById('fm-start').value;
    if (!memberName) { toast('Member name is required', 'error'); return; }
    if (!startDate) { toast('Start date is required', 'error'); return; }
    const amountEl = document.getElementById('fm-amount');
    const paidEl = document.getElementById('fm-paid');
    try {
      await API.post('/api/fitness/memberships', {
        planId: state.selectedPlan.id,
        duration: state.duration,
        memberName,
        memberPhone: document.getElementById('fm-phone').value.trim() || null,
        memberEmail: document.getElementById('fm-email').value.trim() || null,
        roomNumber: document.getElementById('fm-room').value.trim() || null,
        startDate,
        amount: amountEl ? Number(amountEl.value || 0) : undefined,
        paid: paidEl ? paidEl.value === 'true' : undefined,
        notes: document.getElementById('fm-notes').value.trim() || null,
      });
      toast('Member registered (' + durLabel(state.duration) + ')', 'success');
      await load();
      document.getElementById('fm-modal-body').innerHTML = bodyHTML();
      window.__fmRefreshSummary();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__fmAction = async (id, action) => {
    try {
      await API.post('/api/fitness/memberships/' + id + '/' + action);
      toast('Membership ' + (action === 'complete' ? 'completed' : 'cancelled'), 'success');
      await load();
      document.getElementById('fm-modal-body').innerHTML = bodyHTML();
      window.__fmRefreshSummary();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Plan manager (create / edit / delete plans) ───────────────────────
  function planFormInner(p) {
    const plan = p || { name: '', scope: 'both', price_daily: 0, price_monthly: 0, price_quarterly: 0, price_yearly: 0, features: [], benefits: [], active: true };
    return '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Plan Name</label><input class="form-input" id="fmp-name" value="' + escapeHtml(plan.name) + '" placeholder="e.g. Wellness Combo"/></div>' +
        '<div class="form-group"><label class="form-label">Scope</label><select class="form-select" id="fmp-scope">' +
          ['both', 'gym', 'pool'].map(s => '<option value="' + s + '"' + (plan.scope === s ? ' selected' : '') + '>' + SCOPE_LABELS[s] + '</option>').join('') +
        '</select></div>' +
        '<div class="form-group"><label class="form-label">Daily Price ($)</label><input class="form-input" type="number" min="0" id="fmp-daily" value="' + plan.price_daily + '"/></div>' +
        '<div class="form-group"><label class="form-label">Monthly Price ($)</label><input class="form-input" type="number" min="0" id="fmp-monthly" value="' + plan.price_monthly + '"/></div>' +
        '<div class="form-group"><label class="form-label">Quarterly Price ($)</label><input class="form-input" type="number" min="0" id="fmp-quarterly" value="' + plan.price_quarterly + '"/></div>' +
        '<div class="form-group"><label class="form-label">Yearly Price ($)</label><input class="form-input" type="number" min="0" id="fmp-yearly" value="' + plan.price_yearly + '"/></div>' +
        '<div class="form-group"><label class="form-label">Active</label><select class="form-select" id="fmp-active"><option value="true"' + (plan.active ? ' selected' : '') + '>Yes</option><option value="false"' + (!plan.active ? ' selected' : '') + '>No</option></select></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Features (one per line)</label><textarea class="form-input" id="fmp-features" rows="3" placeholder="Gym access&#10;Pool access">' + escapeHtml((plan.features || []).join('\n')) + '</textarea></div>' +
      '<div class="form-group"><label class="form-label">Benefits (one per line)</label><textarea class="form-input" id="fmp-benefits" rows="3" placeholder="Free towel service&#10;10% spa discount">' + escapeHtml((plan.benefits || []).join('\n')) + '</textarea></div>';
  }

  window.__fmManagePlans = () => {
    if (!canManage()) { toast('Only a manager can manage plans', 'error'); return; }
    openModal('Manage Membership Plans',
      '<div class="fm-plan-mgr" id="fm-plan-mgr-list">' +
        (state.plans.length === 0 ? '<div style="font-size:13px;color:var(--text3);margin-bottom:12px">No plans yet — add one below.</div>' :
        state.plans.map(p => '<div class="fm-plan-mgr-row">' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(p.name) + ' ' + badge(SCOPE_LABELS[p.scope] || p.scope, SCOPE_BADGES[p.scope] || 'default') + (p.active ? '' : badge('Inactive', 'default')) + '</div>' +
          '<div style="font-size:11px;color:var(--text3)">' + formatMoney(p.price_monthly) + '/mo · ' + formatMoney(p.price_quarterly) + '/qtr · ' + formatMoney(p.price_yearly) + '/yr' +
          (p.features && p.features.length ? ' · ' + p.features.length + ' features' : '') + (p.benefits && p.benefits.length ? ' · ' + p.benefits.length + ' benefits' : '') + '</div></div>' +
          '<button class="btn ghost sm" id="fmp-edit-' + p.id + '" onclick="window.__fmEditPlan(\'' + p.id + '\')">Edit</button>' +
          '<button class="btn ghost sm" style="color:var(--error)" id="fmp-del-' + p.id + '" onclick="window.__fmDeletePlan(\'' + p.id + '\')">Delete</button>' +
        '</div>').join('')) +
      '</div>' +
      '<div style="border-top:1px solid var(--border);padding-top:14px;margin-top:8px">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:10px" id="fm-plan-form-title">Add a Plan</div>' +
        '<div id="fm-plan-form">' + planFormInner(null) + '</div>' +
      '</div>',
      '<button class="btn outline" onclick="window.__fmOpen()">Done</button>' +
      '<button class="btn primary" id="fmp-save-btn" onclick="window.__fmSavePlan()">Save Plan</button>',
      { wide: true });
    window.__fmPlanEditing = null;
  };

  window.__fmEditPlan = (id) => {
    const p = state.plans.find(x => x.id === id);
    if (!p) return;
    window.__fmPlanEditing = id;
    document.getElementById('fm-plan-form-title').textContent = 'Edit Plan — ' + p.name;
    document.getElementById('fm-plan-form').innerHTML = planFormInner(p);
  };

  window.__fmSavePlan = async () => {
    const name = document.getElementById('fmp-name').value.trim();
    if (!name) { toast('Plan name is required', 'error'); return; }
    const body = {
      name,
      scope: document.getElementById('fmp-scope').value,
      priceDaily: Number(document.getElementById('fmp-daily').value || 0),
      priceMonthly: Number(document.getElementById('fmp-monthly').value || 0),
      priceQuarterly: Number(document.getElementById('fmp-quarterly').value || 0),
      priceYearly: Number(document.getElementById('fmp-yearly').value || 0),
      active: document.getElementById('fmp-active').value === 'true',
      features: document.getElementById('fmp-features').value.split('\n').map(s => s.trim()).filter(Boolean),
      benefits: document.getElementById('fmp-benefits').value.split('\n').map(s => s.trim()).filter(Boolean),
    };
    try {
      if (window.__fmPlanEditing) await API.patch('/api/fitness/plans/' + window.__fmPlanEditing, body);
      else await API.post('/api/fitness/plans', body);
      toast(window.__fmPlanEditing ? 'Plan updated' : 'Plan created', 'success');
      window.__fmPlanEditing = null;
      await load();
      window.__fmManagePlans();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__fmDeletePlan = (id) => {
    const p = state.plans.find(x => x.id === id);
    confirmAction('Delete the plan “' + (p ? p.name : id) + '”? Plans with active memberships cannot be deleted.', async () => {
      try {
        await API.del('/api/fitness/plans/' + id);
        toast('Plan deleted', 'warn');
        if (state.selectedPlan && state.selectedPlan.id === id) state.selectedPlan = null;
        await load();
        window.__fmManagePlans();
      } catch (err) { toast(err.message, 'error'); }
    });
  };
})();
