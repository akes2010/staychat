// server/routes/chat.js
// Public chat endpoint powering the landing-page assistant.
//
// Public but defended: global rate limit applies (mounted under /api), plus a
// tighter per-IP limiter here since chat is the most abuse-prone public surface.
// No auth, no tenant context, no user data — answers come only from the curated
// knowledge base in server/services/help-center.js (the same single source that
// powers /help.html and /api/help), with integration counts pulled live from
// the service registry.
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { search, SUGGESTIONS } = require('../services/help-center');

const router = express.Router();

// Chat-specific limiter: 20 messages per 5 minutes per IP is generous for a
// curious visitor and hostile to scripted scraping/abuse.
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages — please wait a moment and try again.' },
});

router.post('/', chatLimiter, (req, res) => {
  const message = String((req.body && req.body.message) || '').slice(0, 1000);
  if (!message.trim()) return res.status(400).json({ error: 'message is required' });

  const entry = search(message);
  // Context-aware chips: an entry can carry its own follow-up questions so the
  // conversation stays interactive (falls back to the global starters).
  const chips = (entry.followups && entry.followups.length ? entry.followups : SUGGESTIONS).slice(0, 4);
  res.json({
    reply: entry.answer,
    topic: entry.title || null,
    suggestions: chips,
  });
});

// Conversation starters for the widget's first render.
router.get('/suggestions', (req, res) => {
  res.json({ suggestions: SUGGESTIONS });
});

module.exports = router;
