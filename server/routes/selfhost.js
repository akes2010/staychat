// server/routes/selfhost.js
// Public API for the one-time $3,000 "Desk PC Edition" — the offline /
// locally-deployable installation of StayChat OS. Registrations come from the
// landing page's Pricing section (simple form, no account required), and the
// software is mailed to the customer the moment payment is confirmed — see
// services/selfhost.js for confirmation + delivery.
//
// Public (no auth — the customer doesn't have an account yet):
//   POST /api/selfhost/register              — register an order, get a payment reference
//   GET  /api/selfhost/order/:ref            — status poll (no PII); also asks the
//                                              gateway whether a return-from-checkout
//                                              payment actually landed → mails software
//   GET  /api/selfhost/download/:ref/:token  — tokenized installer download (from the email)
// Superadmin (operator confirming a manual bank transfer / POS payment):
//   GET   /api/selfhost/admin/orders?status= — order list
//   GET   /api/selfhost/admin/pending-count  — pending count for the nav badge
//   POST  /api/selfhost/admin/orders/:ref/confirm — mark paid + email the software
//   POST  /api/selfhost/admin/orders/:ref/resend  — re-email licence + download link
//
// Integration points into existing files (kept deliberately minimal):
//   server/index.js        — route mount
//   server/routes/webhooks.js — platform Stripe/Paystack webhook falls back to
//                     selfhost.confirmPayment when a paid charge matches no
//                     subscription, so a customer who never returns from the
//                     gateway still gets the software mailed automatically
//   public/landing.html    — the Desk PC Edition card + registration form
// Everything else (table, emails, checkout, licence) lives in the service.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db/connection');
const { requireAuth, requireRole, audit } = require('../middleware/auth');
const selfhost = require('../services/selfhost');

const router = express.Router();

// A public write endpoint on a marketing page needs its own budget: generous
// for a human registering their hotel, hostile to a script filling the table
// (or using it as an email relay).
const registerLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: Number(process.env.RATE_LIMIT_SELFHOST_MAX) || 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts — please wait a moment and try again.' },
});

// Constant-time compare that never throws on length mismatch.
function tokenMatches(expected, provided) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(provided || ''));
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// POST /register — { name, email, hotelName, phone?, country? }
// Re-posting the same email returns the existing open order instead of
// stacking duplicates (a double-click on the form is harmless).
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await selfhost.registerOrder(body, req);
    res.status(201).json({
      ref: result.order.payment_reference,
      status: result.order.status,
      amount: result.order.amount,
      planId: selfhost.SELFHOST_PLAN.id,
      planName: selfhost.SELFHOST_PLAN.name,
      billing: selfhost.SELFHOST_PLAN.billing, // 'one_time'
      checkoutUrl: result.checkoutUrl || null,
      reused: !!result.reused,
      // Copy the landing page shows right after submit.
      message: 'Registered. Quote your reference with your payment — as soon as payment is confirmed, the install package and licence key are emailed to ' + result.order.email + '.',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /order/:ref — status only (no PII), so the public page can poll it
// without ever exposing customer details. While the order is still pending
// this also asks the gateway (server-side) whether a hosted-checkout payment
// succeeded — that confirmation is what mails the software to the customer.
router.get('/order/:ref', async (req, res) => {
  try {
    const view = await selfhost.getStatus(req.params.ref);
    if (!view) return res.status(404).json({ error: 'Unknown reference' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(view);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /download/:ref/:token — the link the delivery email carries. Only a
// paid/delivered order whose exact generated token matches can fetch it.
router.get('/download/:ref/:token', (req, res) => {
  const order = db.prepare('SELECT * FROM selfhost_orders WHERE payment_reference = ?')
    .get(String(req.params.ref || ''));
  if (!order || !['paid', 'delivered'].includes(order.status) ||
      !tokenMatches(order.download_token, req.params.token)) {
    return res.status(404).json({ error: 'Invalid or expired download link' });
  }

  const file = selfhost.packagePath();
  if (!fs.existsSync(file)) {
    return res.status(404).json({ error: 'The installer package is not available on this server yet — reply to your delivery email and the platform team will send it to you directly.' });
  }
  res.setHeader('Content-Disposition', 'attachment; filename="' + path.basename(file).replace(/["\\]/g, '') + '"');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(file).pipe(res);
});

// ── Operator console (superadmin) ────────────────────────────────────────────
// Manual bank-transfer / POS payments for the one-time plan are confirmed
// here; confirmation is what generates the licence and mails the software.
router.get('/admin/orders', requireAuth, requireRole('superadmin'), (req, res) => {
  res.json(selfhost.listOrders(req.query.status || null));
});

// Lightweight count for the sidebar badge — fetched at app boot and refreshed
// over WS whenever a registration lands; no PII, no order rows.
router.get('/admin/pending-count', requireAuth, requireRole('superadmin'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ pending: selfhost.countPending() });
});

router.post('/admin/orders/:ref/confirm', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const order = await selfhost.confirmAndDeliver(req.params.ref, {
      approvedBy: req.user.name || 'superadmin',
      amount: req.body && req.body.amount != null ? Number(req.body.amount) : undefined,
    });
    audit(req, 'selfhost.order_confirmed', 'selfhost_order', order.id,
      { ref: order.payment_reference, status: order.status, email: order.email });
    res.json(selfhost.publicView(order));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/admin/orders/:ref/resend', requireAuth, requireRole('superadmin'), async (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM selfhost_orders WHERE id = ? OR payment_reference = ?')
      .get(String(req.params.ref), String(req.params.ref));
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['paid', 'delivered'].includes(order.status)) {
      return res.status(409).json({ error: 'Payment not confirmed yet — confirm the order first' });
    }
    const result = await selfhost.resendToCustomer(order);
    audit(req, 'selfhost.delivery_resent', 'selfhost_order', order.id, { ref: order.payment_reference });
    res.json({ ok: true, sent: !!result.sent, reason: result.reason || null });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;