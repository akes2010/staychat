// server/routes/ai-config.js
// AI provider setup & agent configuration. This is a CONFIGURATION surface —
// it stores which provider/model/key powers each agent role and whether the
// hotel is being charged an add-on for it. It does not itself call any AI
// provider's API; wiring a configured provider into the live WhatsApp
// receptionist is a separate integration step.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { encrypt, decrypt, isEncrypted } = require('../utils/crypto-store');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('ai.manage'));

const PROVIDERS = ['openai', 'qwen', 'deepseek', 'huggingface', 'openrouter', 'kimi', 'zai', 'other'];

// api_key is encrypted at rest (crypto-store v1: blob). Reads decrypt
// transparently so the UI mask shows the REAL key's first/last 4 chars;
// legacy plaintext rows written before this change keep masking fine.
function maskedApiKey(v) {
  if (!v) return null;
  let plain = v;
  if (isEncrypted(v)) {
    try { plain = decrypt(v); } catch (e) { return null; } // wrong key → fail closed
  }
  return plain.slice(0, 4) + '••••••••' + plain.slice(-4);
}

// Writes always store encrypted; '' stays '' (cleared), already-encrypted
// values pass through untouched so double-saves can't double-encrypt.
function storeApiKey(v) {
  if (typeof v !== 'string' || v === '' || isEncrypted(v)) return v;
  return encrypt(v);
}

function serialize(c) { return { ...c, active: !!c.active, apiKeyMasked: maskedApiKey(c.api_key), api_key: undefined }; }

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM ai_configs WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenantId).map(serialize));
});

router.get('/providers', (req, res) => res.json(PROVIDERS));

router.post('/', (req, res) => {
  const { provider, label, model, apiKey, agentRole, monthlySurcharge } = req.body;
  if (!provider || !label) return res.status(400).json({ error: 'provider and label are required' });
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
  const id = 'ai_' + nanoid(10);
  db.prepare(`INSERT INTO ai_configs (id, tenant_id, provider, label, model, api_key, agent_role, monthly_surcharge) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, provider, label, model || null, storeApiKey(apiKey) || null, agentRole || 'receptionist', Number(monthlySurcharge) || 0);
  const config = db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(id);
  audit(req, 'ai.config_create', 'ai_config', id, { provider, label });
  res.status(201).json(serialize(config));
});

router.patch('/:id', (req, res) => {
  const config = db.prepare('SELECT * FROM ai_configs WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!config) return res.status(404).json({ error: 'Config not found' });
  const map = { label: 'label', model: 'model', apiKey: 'api_key', agentRole: 'agent_role', monthlySurcharge: 'monthly_surcharge', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (updates.api_key !== undefined) updates.api_key = storeApiKey(updates.api_key);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE ai_configs SET ${setClause} WHERE id = @id`).run({ ...updates, id: config.id });
  audit(req, 'ai.config_update', 'ai_config', config.id, Object.keys(updates));
  res.json(serialize(db.prepare('SELECT * FROM ai_configs WHERE id = ?').get(config.id)));
});

router.delete('/:id', (req, res) => {
  const config = db.prepare('SELECT * FROM ai_configs WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!config) return res.status(404).json({ error: 'Config not found' });
  db.prepare('DELETE FROM ai_configs WHERE id = ?').run(config.id);
  audit(req, 'ai.config_delete', 'ai_config', config.id);
  res.json({ ok: true });
});

module.exports = router;
