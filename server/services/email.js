// server/services/email.js
// Transactional email for the PLATFORM and its tenants.
//
// Provider priority (first configured wins):
//   1. Resend (RESEND_API_KEY) — simple HTTP API, generous free tier (100/day),
//      ideal for VPS/cloud deploys. https://resend.com/docs
//   2. Generic SMTP via env (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM)
//      — only if `nodemailer` happens to be installed; never a hard dependency.
//   3. Disabled — every send resolves { sent: false, reason: 'disabled' } and
//      logs the would-be payload. The app must NEVER break because email is
//      not configured (same fire-and-forget philosophy as WhatsApp sends).
//
// Hardened transport: same IPv4-pinned node:https client as the AI receptionist
// (avoids the Happy-Eyeballs ETIMEDOUT failure mode on some VPS hosts).
'use strict';

const https = require('https');
const crypto = require('crypto');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'StayChat OS <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');

// ── Transport ───────────────────────────────────────────────────────────────
function httpPostJson(urlString, headers, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers,
      family: 4,
      timeout: 10000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = text ? JSON.parse(text) : {}; } catch (e) { /* non-JSON body */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('email request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Providers ───────────────────────────────────────────────────────────────
async function sendViaResend({ to, subject, html, text }) {
  const res = await httpPostJson('https://api.resend.com/emails', {
    Authorization: 'Bearer ' + RESEND_API_KEY,
    'Content-Type': 'application/json',
  }, JSON.stringify({ from: EMAIL_FROM, to: Array.isArray(to) ? to : [to], subject, html, text }));
  if (!res.ok) throw new Error('Resend API ' + res.status + (res.json?.message ? ': ' + res.json.message : ''));
  return { id: res.json?.id || null };
}

async function sendViaSMTP({ to, subject, html, text }) {
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch (e) {
    throw new Error('SMTP_HOST is set but nodemailer is not installed (npm i nodemailer)');
  }
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    family: 4,
    connectionTimeout: 10000,
  });
  const info = await transport.sendMail({ from: process.env.SMTP_FROM || EMAIL_FROM, to, subject, html, text });
  return { id: info?.messageId || null };
}

function providerName() {
  if (RESEND_API_KEY) return 'resend';
  if (process.env.SMTP_HOST) return 'smtp';
  return 'disabled';
}

/**
 * Send a transactional email. Never throws — returns a result object so
 * callers can fire-and-forget without try/catch.
 * @returns {Promise<{sent: boolean, provider?: string, id?: string, reason?: string}>}
 */
async function sendEmail({ to, subject, html, text }) {
  if (!to || !subject) return { sent: false, reason: 'invalid' };
  const provider = providerName();
  if (provider === 'disabled') {
    console.log('[email] disabled — would send to', to, '·', subject);
    return { sent: false, reason: 'disabled' };
  }
  try {
    const result = provider === 'resend'
      ? await sendViaResend({ to, subject, html, text })
      : await sendViaSMTP({ to, subject, html, text });
    return { sent: true, provider, ...result };
  } catch (err) {
    console.error('[email] send failed via ' + provider + ':', err.message);
    return { sent: false, reason: err.message };
  }
}

// ── Branded template ────────────────────────────────────────────────────────
function wrap(title, bodyHtml) {
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0f1b2d;font-family:-apple-system,Segoe UI,Roboto,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 20px">' +
    '<div style="text-align:center;color:#fff;font-weight:800;font-size:17px;margin-bottom:20px">' +
    '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#4f8cff,#22d3a7);margin-right:8px"></span>StayChat OS</div>' +
    '<div style="background:#fff;border-radius:16px;padding:28px;color:#1e293b">' +
    '<h1 style="font-size:19px;margin:0 0 14px">' + escapeHtml(title) + '</h1>' +
    bodyHtml +
    '</div>' +
    '<div style="text-align:center;color:rgba(255,255,255,.55);font-size:11.5px;margin-top:16px">Delivered by StayChat OS — the WhatsApp-native hotel platform</div>' +
    '</div></body></html>';
}

function refBox(label, value) {
  return '<div style="text-align:center;background:#eff6ff;border:2px dashed #2563eb;border-radius:12px;padding:14px;margin:16px 0">' +
    '<div style="font-size:10.5px;letter-spacing:1.5px;color:#64748b;font-weight:700">' + escapeHtml(label) + '</div>' +
    '<div style="font-size:24px;font-weight:800;letter-spacing:2px;color:#1d4ed8;margin-top:4px;user-select:all">' + escapeHtml(value) + '</div></div>';
}

// ── Emails ──────────────────────────────────────────────────────────────────
function signupWelcomeEmail({ hotelName, ownerName, subdomain, plan, trialEndsAt, paymentReference }) {
  const bookUrl = APP_URL ? APP_URL + '/book.html?hotel=' + encodeURIComponent(subdomain || '') : null;
  const appUrl = APP_URL ? APP_URL + '/app' : null;
  const html = wrap('Welcome to StayChat OS, ' + (ownerName || 'there') + '!',
    '<p style="font-size:14px;line-height:1.7">Your hotel <b>' + escapeHtml(hotelName) + '</b> is live on a 14-day free trial of the <b>' + escapeHtml(plan || 'Starter') + '</b> plan' +
    (trialEndsAt ? ' (until ' + escapeHtml(String(trialEndsAt).slice(0, 10)) + ')' : '') + '. Every feature is unlocked — add your rooms, connect WhatsApp, and take bookings.</p>' +
    (paymentReference ? refBox('PAYMENT REFERENCE (activates your plan)', paymentReference) : '') +
    (bookUrl ? '<p style="font-size:13px;color:#475569">Your public booking page:<br><a href="' + bookUrl + '" style="color:#2563eb">' + escapeHtml(bookUrl) + '</a></p>' : '') +
    (appUrl ? '<p style="margin:18px 0 0"><a href="' + appUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;padding:11px 22px;font-weight:700;font-size:14px">Open my dashboard →</a></p>' : ''));
  return {
    subject: 'Your StayChat OS trial is live — 14 days, every feature',
    html,
    text: 'Welcome to StayChat OS!\n\n' + hotelName + ' is live on a 14-day trial of the ' + (plan || 'Starter') + ' plan.' +
      (paymentReference ? '\n\nPayment reference: ' + paymentReference : '') +
      (bookUrl ? '\n\nBooking page: ' + bookUrl : '') + (appUrl ? '\nDashboard: ' + appUrl : ''),
  };
}

function planRequestedEmail({ hotelName, planName, billingCycle, amount, paymentReference, checkoutUrl }) {
  const html = wrap('Complete your ' + escapeHtml(planName) + ' plan activation',
    '<p style="font-size:14px;line-height:1.7"><b>' + escapeHtml(hotelName) + '</b> requested the <b>' + escapeHtml(planName) + '</b> plan (' + escapeHtml(billingCycle) + ').</p>' +
    '<p style="font-size:14px">Amount due: <b>$' + Number(amount).toLocaleString('en-US') + '</b></p>' +
    (checkoutUrl
      ? '<p style="margin:18px 0 0"><a href="' + checkoutUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;padding:11px 22px;font-weight:700;font-size:14px">Pay securely now →</a></p>'
      : refBox('PAYMENT REFERENCE', paymentReference) + '<p style="font-size:13px;color:#475569">Pay by bank transfer / POS and quote this reference as the narration — your plan activates as soon as payment is confirmed.</p>'));
  return {
    subject: 'Activate your ' + planName + ' plan — ' + (checkoutUrl ? 'pay securely online' : 'reference ' + paymentReference),
    html,
    text: 'Activate your ' + planName + ' (' + billingCycle + ') plan for ' + hotelName + '.\nAmount: $' + amount +
      (checkoutUrl ? '\nPay here: ' + checkoutUrl : '\nPayment reference: ' + paymentReference + ' — quote it with your bank transfer.'),
  };
}

function subscriptionActivatedEmail({ hotelName, planName, periodEnd, auto }) {
  const html = wrap('Your subscription is active 🎉',
    '<p style="font-size:14px;line-height:1.7"><b>' + escapeHtml(hotelName) + '</b> is now on the <b>' + escapeHtml(planName) + '</b> plan' +
    (periodEnd ? ' — valid until <b>' + escapeHtml(periodEnd) + '</b>' : '') + '.</p>' +
    '<p style="font-size:13px;color:#475566">' + (auto ? 'Payment received automatically via your gateway.' : 'Payment confirmed by the platform team.') + ' Thank you for building with StayChat OS.</p>');
  return { subject: 'Your ' + planName + ' plan is active', html, text: hotelName + ' is now on the ' + planName + ' plan' + (periodEnd ? ' until ' + periodEnd : '') + '.' };
}

function bookingSubmittedEmail({ hotelName, guestName, reference, code, checkIn, checkOut, rooms, total, currency }) {
  const html = wrap('Reservation received — ' + escapeHtml(hotelName),
    '<p style="font-size:14px;line-height:1.7">Hi ' + escapeHtml(guestName) + ', we received your reservation request.</p>' +
    refBox('YOUR TENDER CODE', code) +
    '<p style="font-size:13.5px;line-height:1.8">Reference: <b>' + escapeHtml(reference) + '</b><br>' +
    'Rooms: <b>' + escapeHtml(rooms) + '</b><br>' +
    'Stay: <b>' + escapeHtml(checkIn) + ' → ' + escapeHtml(checkOut) + '</b><br>' +
    'Total (pay at hotel): <b>' + escapeHtml(currency) + escapeHtml(total) + '</b></p>' +
    '<p style="font-size:13px;color:#475569">The hotel will confirm your booking shortly — rooms are held on a first-confirm basis. Present your code at the front desk.</p>');
  return { subject: 'Reservation received — code ' + code, html, text: 'Reservation ' + reference + ' (code ' + code + ') for ' + checkIn + ' → ' + checkOut + '. Total ' + currency + total + ', pay at hotel.' };
}

function renewalReminderEmail({ hotelName, planName, periodEnd, daysLeft, paymentReference }) {
  const html = wrap('Your plan renews in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's'),
    '<p style="font-size:14px;line-height:1.7"><b>' + escapeHtml(hotelName) + '</b> is on the <b>' + escapeHtml(planName) + '</b> plan, which expires on <b>' + escapeHtml(periodEnd) + '</b>.</p>' +
    '<p style="font-size:13.5px;color:#475569">To keep every feature (booking engine, WhatsApp inbox, accounting, guest Wi-Fi…), complete your renewal before the expiry date. Quote your payment reference with your transfer — or pay online from Billing &amp; Plan in the app.</p>' +
    (paymentReference ? refBox('RENEWAL REFERENCE', paymentReference) : ''));
  return {
    subject: 'Action needed: your ' + planName + ' plan expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's'),
    html,
    text: hotelName + ': your ' + planName + ' plan expires on ' + periodEnd + ' (in ' + daysLeft + ' days).' + (paymentReference ? ' Renewal reference: ' + paymentReference : ''),
  };
}

function subscriptionExpiredEmail({ hotelName, planName, periodEnd }) {
  const html = wrap('Your subscription has expired',
    '<p style="font-size:14px;line-height:1.7">The <b>' + escapeHtml(planName) + '</b> plan for <b>' + escapeHtml(hotelName) + '</b> expired on ' + escapeHtml(periodEnd) + '. The account is now suspended and premium modules are locked.</p>' +
    '<p style="font-size:13px;color:#475569">Your data is safe. Renew any time from Billing &amp; Plan — or reply to this email and the platform team will help.</p>');
  return { subject: 'Your StayChat OS subscription has expired', html, text: hotelName + ': ' + planName + ' plan expired on ' + periodEnd + '. Account suspended — data is safe.' };
}

module.exports = {
  sendEmail,
  providerName,
  signupWelcomeEmail,
  planRequestedEmail,
  subscriptionActivatedEmail,
  bookingSubmittedEmail,
  renewalReminderEmail,
  subscriptionExpiredEmail,
};
