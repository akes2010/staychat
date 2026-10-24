// public/js/pages/billing.js
// Billing & Plan — the hotel's subscription cockpit: current plan, usage vs.
// limits, trial countdown, pending activation requests with payment reference,
// plan comparison and the request/upgrade flow.
'use strict';

window.PAGES = window.PAGES || {};

PAGES.billing = function () {
  const el = document.createElement('div');
  // Defense in depth: the nav item is already hidden from non-managers and
  // navigate() enforces the capability — this catches any other entry point.
  if (typeof can !== 'function' || !can('billing.manage')) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🔒</div><div class="empty-state-title">Billing & Plan is available to the hotel owner/admin only</div><div class="empty-state-sub">Ask the owner if you need a plan change.</div></div>';
    return el;
  }
  el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">💳</div><div class="empty-state-title">Loading billing…</div></div>';
  loadBilling(el);
  return el;
};

async function loadBilling(container) {
  const root = container || document.getElementById('content');
  if (!root) return;
  let snap;
  try {
    snap = await API.get('/api/billing/summary');
  } catch (e) {
    root.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">' + (e.message || 'Could not load billing') + '</div></div>';
    return;
  }

  const pricing = await API.get('/api/billing/pricing').catch(() => ({ plans: [] }));
  const plans = pricing.plans || [];
  const ent = snap;

  // ── Usage meters ──
  // /api/billing/usage is open to every signed-in hotel user (unlike
  // /api/rooms + /api/users, which are capability-gated), so the plan meters
  // and plan comparison render for the whole team, not just the owner/admin.
  const [rooms, users] = await Promise.all([
    API.get('/api/billing/usage').then(u => u.rooms).catch(() => null),
    API.get('/api/billing/usage').then(u => u.users).catch(() => null),
  ]);

  const meter = (label, used, max) => {
    if (max === null || max === undefined) return '<div style="font-size:12.5px;color:var(--text3)">' + label + ': <b>' + (used ?? '—') + '</b> · unlimited</div>';
    const pct = Math.min(100, Math.round((used / max) * 100));
    const color = pct >= 90 ? 'var(--danger,#e5484d)' : pct >= 70 ? 'var(--warn,#f5a623)' : 'var(--success,#22c55e)';
    return '<div style="font-size:12.5px;margin-bottom:4px">' + label + ': <b>' + used + ' / ' + max + '</b></div>' +
      '<div style="height:7px;border-radius:4px;background:var(--surface2);overflow:hidden;margin-bottom:10px"><div style="height:100%;width:' + pct + '%;background:' + color + '"></div></div>';
  };

  const statusChip =
    ent.status === 'trial' ? '<span style="background:rgba(79,140,255,.15);color:#7aa8ff;padding:3px 10px;border-radius:12px;font-size:11.5px;font-weight:700">TRIAL — ' + (ent.trial ? ent.trial.daysLeft : '?') + ' DAYS LEFT</span>' :
    ent.status === 'active' ? '<span style="background:rgba(34,197,94,.15);color:#22c55e;padding:3px 10px;border-radius:12px;font-size:11.5px;font-weight:700">ACTIVE</span>' :
    '<span style="background:rgba(229,72,77,.15);color:#e5484d;padding:3px 10px;border-radius:12px;font-size:11.5px;font-weight:700">' + (ent.pendingApproval ? 'AWAITING APPROVAL' : 'SUSPENDED') + '</span>';

  const pendingCard = snap.pending ? (
    '<div class="card" style="padding:18px;border-color:var(--primary)">' +
      '<h3 style="font-size:15px;margin-bottom:6px">⏳ Activation pending — ' + snap.pending.plan_id + ' (' + snap.pending.billing_cycle + ')</h3>' +
      '<p style="font-size:12.5px;color:var(--text3);margin-bottom:10px">Pay <b>$' + snap.pending.amount + '</b> and share this reference with the platform team. Activation is usually within one business day.</p>' +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
        '<div style="background:var(--surface2);border-radius:10px;padding:10px 16px;font-size:20px;font-weight:800;letter-spacing:2px">' + snap.pending.payment_reference + '</div>' +
        '<button class="btn outline" onclick="cancelPlanRequest(this)">Cancel request</button>' +
      '</div></div>'
  ) : '';

  // In-app renewal reminder — mirrors the 7-day/1-day email reminders so the
  // hotel also sees it where they work. One-click re-request of the same plan
  // issues a fresh SC- reference (or opens hosted checkout when automated).
  const renewal = snap.renewal || null;
  const renewalCard = renewal && (renewal.expiringSoon || (renewal.daysLeft !== null && renewal.daysLeft < 0)) ? (
    '<div class="card" style="padding:18px;border-color:' + (renewal.daysLeft < 0 ? 'var(--danger,#e5484d)' : 'var(--warn,#f5a623)') + '">' +
      '<h3 style="font-size:15px;margin-bottom:6px">' + (renewal.daysLeft < 0 ? '🔴' : '🔔') + ' ' +
        (renewal.daysLeft < 0
          ? 'Your ' + renewal.planId + ' plan expired on ' + renewal.periodEnd
          : 'Your ' + renewal.planId + ' plan renews in ' + renewal.daysLeft + ' day' + (renewal.daysLeft === 1 ? '' : 's')) + '</h3>' +
      '<p style="font-size:12.5px;color:var(--text3);margin-bottom:10px">' +
        (renewal.daysLeft < 0
          ? 'Premium modules lock when the grace period ends. Renew now to keep everything running.'
          : 'Renew before ' + renewal.periodEnd + ' to keep every feature — booking engine, WhatsApp inbox, accounting, guest Wi-Fi.') + '</p>' +
      '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
        '<div style="background:var(--surface2);border-radius:10px;padding:10px 16px;font-size:18px;font-weight:800;letter-spacing:1.5px">' + (renewal.paymentReference || '') + '</div>' +
        '<div style="font-size:12.5px;color:var(--text3)">' + renewal.billingCycle + ' · $' + renewal.amount + '</div>' +
        (canManageBilling()
          ? '<button class="btn primary" onclick="requestPlanFromModalShared(\'' + renewal.planId + '\', \'' + renewal.billingCycle + '\')">Renew now</button>'
          : '<span style="font-size:12px;color:var(--text3)">The hotel admin handles renewal</span>') +
      '</div></div>'
  ) : '';

  const planRows = plans.map(p => {
    const isCurrent = p.id === ent.planId;
    const isPending = snap.pending && snap.pending.plan_id === p.id;
    return '<div style="border:1px solid ' + (isCurrent ? 'var(--primary)' : 'var(--border)') + ';border-radius:14px;padding:18px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
        '<b style="font-size:15px">' + p.name + '</b>' +
        (isCurrent ? '<span style="font-size:11px;color:#22c55e;font-weight:700">CURRENT</span>' : isPending ? '<span style="font-size:11px;color:#7aa8ff;font-weight:700">PENDING</span>' : '') +
      '</div>' +
      '<div style="font-size:22px;font-weight:800">$' + p.priceMonthly + '<span style="font-size:12px;color:var(--text3);font-weight:500">/mo · or $' + p.priceYearly + '/yr</span></div>' +
      '<div style="font-size:12px;color:var(--text3);margin:6px 0 10px">' + p.featureLabels.slice(0, 5).join(' · ') + '…</div>' +
      (isCurrent || isPending
        ? '<button class="btn outline full" disabled style="opacity:.6">' + (isCurrent ? 'Current plan' : 'Requested') + '</button>'
        : canManageBilling()
          ? '<button class="btn ' + (p.id === 'pro' ? 'primary' : 'outline') + ' full" onclick="requestPlanFromPage(\'' + p.id + '\')">Switch to ' + p.name + '</button>'
          : '<div style="font-size:11.5px;color:var(--text3);text-align:center;padding:8px 0">Plan changes are handled by the hotel admin</div>') +
      '</div>';
  }).join('');

  const history = (snap.history || []).filter(s => s.status !== 'pending_approval').slice(0, 8);
  const historyRows = history.length
    ? history.map(s => '<tr><td>' + s.plan_id + '</td><td>' + s.billing_cycle + '</td><td>$' + s.amount + '</td><td>' + s.status + '</td><td>' + (s.payment_reference || '—') + '</td><td>' + (s.approved_at ? s.approved_at.slice(0, 10) : '—') + '</td></tr>').join('')
    : '<tr><td colspan="6" style="text-align:center;color:var(--text3)">No billing history yet</td></tr>';

  root.innerHTML =
    '<div style="max-width:1000px;margin:0 auto;display:grid;gap:18px">' +

      '<div class="card" style="padding:22px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center">' +
        '<div><div style="font-size:12px;color:var(--text3);letter-spacing:1px">CURRENT PLAN</div>' +
          '<div style="font-size:26px;font-weight:800;margin:4px 0">' + ent.planName + ' ' + statusChip + '</div>' +
          '<div style="font-size:12.5px;color:var(--text3)">' +
            (ent.trial ? 'Trial ends ' + (ent.trial.endsAt || '') + ' — full features until then.' :
             ent.subscription && ent.subscription.periodEnd ? 'Renews ' + ent.subscription.periodEnd + ' · $' + ent.subscription.amount + '/' + ent.subscription.billingCycle.replace('ly', '') :
             ent.status === 'suspended' ? 'Subscription inactive — choose a plan below to reactivate.' : '') +
          '</div></div>' +
        '<div style="min-width:260px">' + meter('Rooms', rooms, ent.limits.maxRooms) + meter('Staff logins', users, ent.limits.maxUsers) + '</div>' +
      '</div>' +

      pendingCard +

      renewalCard +

      '<div class="card" style="padding:22px"><h3 style="font-size:16px;margin-bottom:14px">Plans</h3>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px">' + planRows + '</div>' +
        '<div style="font-size:11.5px;color:var(--text3);margin-top:12px">Choose monthly or yearly at checkout — yearly saves 2 months. Payment is reconciled by the platform team via bank transfer, POS or any configured gateway.</div>' +
      '</div>' +

      '<div class="card" style="padding:22px"><h3 style="font-size:16px;margin-bottom:12px">Billing history</h3>' +
        '<table style="width:100%;font-size:12.5px;border-collapse:collapse">' +
          '<thead><tr style="color:var(--text3);text-align:left">' + ['Plan', 'Cycle', 'Amount', 'Status', 'Reference', 'Date'].map(h => '<th style="padding:6px 8px;font-weight:600">' + h + '</th>').join('') + '</tr></thead>' +
          '<tbody>' + historyRows + '</tbody></table>' +
      '</div>' +
    '</div>';
}

// Only hotel admins (and the platform superadmin) may request plan changes —
// mirrors the server-side gate on POST /api/billing/request-plan.
function canManageBilling() {
  const r = App.user && App.user.role;
  return r === 'hotel_admin' || r === 'superadmin';
}

async function requestPlanFromPage(planId) {
  const cycle = prompt('Billing cycle — type "monthly" or "yearly":', 'monthly');
  if (cycle === null) return;
  requestPlanFromModalShared(planId, cycle.trim().toLowerCase() === 'yearly' ? 'yearly' : 'monthly');
}

async function cancelPlanRequest(btn) {
  btn.disabled = true;
  try {
    await API.post('/api/billing/cancel-request', {});
    toast('Request cancelled', 'success');
    loadBilling();
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
}

// Shared with app.js upgrade modal (which posts without asking cycle).
// When the platform operator has automated payments (gateway configured), the
// response carries a hosted checkoutUrl — send the hotel straight there so the
// subscription activates via webhook with no manual approval step.
async function requestPlanFromModalShared(planId, cycle) {
  if (!canManageBilling()) { toast('Only the hotel admin can change plans', 'error'); return; }
  try {
    const r = await API.post('/api/billing/request-plan', { planId, billingCycle: cycle || 'monthly' });
    // Desk edition: there is no platform operator to approve anything — the
    // request activates the plan immediately, so skip the reference step.
    if (r.activated) {
      toast('Plan activated — ' + ((r.plan && r.plan.name) || planId), 'success', 4000);
      loadBilling();
      return;
    }
    if (r.checkoutUrl) {
      toast('Redirecting to secure checkout…', 'success', 4000);
      setTimeout(() => { window.location.href = r.checkoutUrl; }, 800);
      return;
    }
    toast('Request recorded — reference ' + r.paymentReference, 'success', 6000);
    loadBilling();
  } catch (e) { toast(e.message, 'error'); }
}
