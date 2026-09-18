// server/services/subscription-scheduler.js
// Hourly subscription lifecycle job:
//   1. Renewal reminders — 7 days and 1 day before an active subscription's
//      period_end, the hotel's admin gets an email (deduped per milestone via
//      billing_events) plus a billing_events trail entry.
//   2. Expiry sweep — active subscriptions past period_end flip the tenant's
//      subscription_status to 'suspended' (requireTenant then blocks the
//      premium app with the SUSPENDED code, exactly like a manual suspend)
//      and the tenant gets an expiry notice email. Tenants.status itself is
//      untouched, so the public booking widget and data stay browsable.
//   3. Trial sweep — the boot-time entitlements sweep also runs here so an
//      always-on server catches expiries without restarts.
//
// Everything is idempotent and safe to run repeatedly. Email is fire-and-
// forget: send failures log but never break the sweep.
'use strict';

const db = require('../db/connection');
const billing = require('./billing');
const email = require('./email');
const entitlements = require('./entitlements');
const { broadcast } = require('../ws');

const DAY_MS = 86400000;
const REMINDER_DAYS = [7, 1];

function tenantAdminEmail(tenantId) {
  const row = db.prepare(
    `SELECT email FROM users WHERE tenant_id = ? AND role = 'hotel_admin' AND active = 1 AND email IS NOT NULL
     ORDER BY created_at ASC LIMIT 1`
  ).get(tenantId);
  return row ? row.email : null;
}

function reminderAlreadySent(tenantId, note) {
  return !!db.prepare(
    `SELECT 1 FROM billing_events WHERE tenant_id = ? AND type = 'renewal.reminder' AND note = ? LIMIT 1`
  ).get(tenantId, note);
}

function daysUntil(dateStr) {
  return Math.ceil((new Date(dateStr + 'T00:00:00Z').getTime() - Date.now()) / DAY_MS);
}

function sendReminders() {
  const due = db.prepare(
    `SELECT * FROM platform_subscriptions
     WHERE status = 'active' AND period_end IS NOT NULL
       AND period_end IN (date('now', '+7 days'), date('now', '+1 day'))`
  ).all();
  let sent = 0;
  for (const sub of due) {
    const daysLeft = daysUntil(sub.period_end);
    const note = 'Days left: ' + daysLeft + ' (expires ' + sub.period_end + ')';
    if (reminderAlreadySent(sub.tenant_id, note)) continue;

    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(sub.tenant_id);
    const to = tenantAdminEmail(sub.tenant_id);
    const plan = entitlements.PLAN_CATALOG[sub.plan_id];
    const payload = email.renewalReminderEmail({
      hotelName: tenant ? tenant.name : sub.tenant_id,
      planName: plan ? plan.name : sub.plan_id,
      periodEnd: sub.period_end,
      daysLeft,
      paymentReference: sub.payment_reference,
    });
    if (to) email.sendEmail({ to, ...payload }).then(r => { if (!r.sent) console.warn('[scheduler] reminder email not sent:', r.reason); });
    billing.logEvent(sub.tenant_id, 'renewal.reminder', note, sub.amount, sub.payment_reference);
    broadcast(sub.tenant_id, 'renewal.reminder', { planId: sub.plan_id, periodEnd: sub.period_end, daysLeft });
    sent += 1;
  }
  return sent;
}

function sweepExpiredSubscriptions() {
  const expired = db.prepare(
    `SELECT * FROM platform_subscriptions WHERE status = 'active' AND period_end IS NOT NULL AND date(period_end) < date('now')`
  ).all();
  let swept = 0;
  for (const sub of expired) {
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(sub.tenant_id);
    const plan = entitlements.PLAN_CATALOG[sub.plan_id];
    const doSweep = db.transaction(() => {
      db.prepare(`UPDATE platform_subscriptions SET status = 'superseded' WHERE id = ?`).run(sub.id);
      db.prepare(`UPDATE tenants SET subscription_status = 'suspended', updated_at = datetime('now') WHERE id = ?`).run(sub.tenant_id);
      billing.logEvent(sub.tenant_id, 'subscription.expired',
        (plan ? plan.name : sub.plan_id) + ' subscription expired on ' + sub.period_end + ' — premium modules locked',
        sub.amount, sub.payment_reference);
    });
    doSweep();

    const to = tenantAdminEmail(sub.tenant_id);
    if (to && tenant) {
      const payload = email.subscriptionExpiredEmail({
        hotelName: tenant.name,
        planName: plan ? plan.name : sub.plan_id,
        periodEnd: sub.period_end,
      });
      email.sendEmail({ to, ...payload }).catch(() => {});
    }
    broadcast(sub.tenant_id, 'subscription.expired', { planId: sub.plan_id, periodEnd: sub.period_end });
    swept += 1;
  }
  return swept;
}

function runAll() {
  const reminders = sendReminders();
  const expired = sweepExpiredSubscriptions();
  const trials = entitlements.sweepExpiredTrials();
  if (reminders || expired || trials) {
    console.log('[scheduler] renewal reminders: ' + reminders + ' · subscriptions expired: ' + expired + ' · trials swept: ' + trials);
  }
  return { reminders, expired, trials };
}

let timer = null;
function start(intervalMs) {
  runAll(); // once at boot
  if (timer) return;
  timer = setInterval(runAll, intervalMs || 60 * 60 * 1000); // hourly
  timer.unref(); // never keep the process alive just for the scheduler
}

module.exports = { start, runAll, sendReminders, sweepExpiredSubscriptions };
