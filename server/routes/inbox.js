// server/routes/inbox.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { broadcast } = require('../ws');
const { getAIReply } = require('../ai/receptionist');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

// GET /api/inbox/conversations
router.get('/conversations', (req, res) => {
  const rows = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? ORDER BY last_message_at DESC').all(req.tenantId);
  res.json(rows.map(r => ({ ...r, online: !!r.online })));
});

// GET /api/inbox/conversations/:id/messages
router.get('/conversations/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conv.id);
  // Mark read
  db.prepare('UPDATE conversations SET unread_count = 0 WHERE id = ?').run(conv.id);
  res.json({ conversation: { ...conv, online: !!conv.online }, messages: msgs.map(m => ({ ...m, aiGenerated: !!m.ai_generated })) });
});

// POST /api/inbox/conversations  — start a new conversation
router.post('/conversations', (req, res) => {
  const { guestName, guestPhone, roomNumber, firstMessage } = req.body;
  if (!guestName || !guestPhone) return res.status(400).json({ error: 'guestName and guestPhone are required' });

  const cid = 'conv_' + nanoid(10);
  db.prepare(`INSERT INTO conversations (id, tenant_id, guest_name, guest_phone, room_number, online, unread_count, last_message)
              VALUES (?,?,?,?,?, 0, 0, ?)`)
    .run(cid, req.tenantId, guestName, guestPhone, roomNumber || null, firstMessage || '');

  if (firstMessage) {
    db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body) VALUES (?,?,?, 'staff', ?)`)
      .run('msg_' + nanoid(10), req.tenantId, cid, firstMessage);
  }
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(cid);
  audit(req, 'inbox.conversation_create', 'conversation', cid, { guestName });
  broadcast(req.tenantId, 'conversation.created', conv);
  res.status(201).json(conv);
});

// POST /api/inbox/conversations/:id/messages  — staff sends a message
router.post('/conversations/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  const mid = 'msg_' + nanoid(10);
  db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body) VALUES (?,?,?, 'staff', ?)`)
    .run(mid, req.tenantId, conv.id, body.trim());
  db.prepare(`UPDATE conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?`).run(body.trim(), conv.id);

  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(mid);
  broadcast(req.tenantId, 'message.created', { conversationId: conv.id, message: msg });
  res.status(201).json(msg);
});

// POST /api/inbox/simulate-incoming  — for demo/testing: simulate a guest message + trigger AI
// (In production this logic lives in the WhatsApp webhook handler — see server/routes/webhooks.js)
router.post('/conversations/:id/simulate-guest-message', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body is required' });

  const guestMsgId = 'msg_' + nanoid(10);
  db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body) VALUES (?,?,?, 'guest', ?)`)
    .run(guestMsgId, req.tenantId, conv.id, body.trim());

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId);
  let aiMsg = null;
  if (tenant.ai_enabled) {
    const replyText = getAIReply(body);
    const aiMsgId = 'msg_' + nanoid(10);
    db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body, ai_generated) VALUES (?,?,?, 'ai', ?, 1)`)
      .run(aiMsgId, req.tenantId, conv.id, replyText);
    aiMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(aiMsgId);
    db.prepare(`UPDATE conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?`).run(replyText, conv.id);
  } else {
    db.prepare(`UPDATE conversations SET last_message = ?, unread_count = unread_count + 1, last_message_at = datetime('now') WHERE id = ?`).run(body.trim(), conv.id);
  }

  const guestMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(guestMsgId);
  broadcast(req.tenantId, 'message.created', { conversationId: conv.id, message: guestMsg });
  if (aiMsg) broadcast(req.tenantId, 'message.created', { conversationId: conv.id, message: aiMsg });

  res.status(201).json({ guestMessage: guestMsg, aiReply: aiMsg });
});

module.exports = router;
