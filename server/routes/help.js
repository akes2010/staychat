// server/routes/help.js — public knowledge-base API for /help.html.
// Read-only, no auth, no user data. Rate-limited via the global /api limiter.
'use strict';

const express = require('express');
const kb = require('../services/help-center');

const router = express.Router();

// Full manual + FAQ (the Help Center page renders from this and keeps working
// offline via its service-worker cache once loaded).
router.get('/', (req, res) => {
  res.json({
    version: kb.HELP_VERSION,
    manual: kb.MANUAL.map(m => ({ id: m.id, icon: m.icon, category: m.category, title: m.title, body: m.body })),
    faq: kb.FAQ.map(f => ({ q: f.q, a: f.a })),
  });
});

// Search across manual + FAQ (used by the Help Center search box).
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ manual: [], faq: [] });
  res.json({
    manual: kb.searchManual(q, 5).map(m => ({ id: m.id, icon: m.icon, category: m.category, title: m.title, body: m.body })),
    faq: kb.searchFaq(q, 5).map(f => ({ q: f.q, a: f.a })),
  });
});

module.exports = router;
