// server/routes/api-integrations.js
// Manage external API service configurations (payment gateways, OTA channels,
// SMS/email providers, storage, etc.) for each tenant.
'use strict';

const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { SERVICE_DEFINITIONS, getAvailableServices, getServiceDefinition, getCategories } = require('../config/api-services');
const { encryptJSON, decryptJSON } = require('../utils/crypto-store');
const { testConnection } = require('../utils/service-tests');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

// ── GET /api/api-integrations — list all configured services for this tenant
router.get('/', requirePermission('settings.manage'), (req, res) => {
  const { category } = req.query;
  let sql = 'SELECT * FROM tenant_api_configs WHERE tenant_id = ?';
  const params = [req.tenantId];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  sql += ' ORDER BY category, service_key';
  const configs = db.prepare(sql).all(...params);

  // Mask sensitive credentials in the response
  const safe = configs.map(c => ({
    ...c,
    credentials: maskCredentials(c.service_key, decryptJSON(c.credentials)),
  }));

  res.json(safe);
});

// ── GET /api/api-integrations/available — list all available service definitions
router.get('/available', (req, res) => {
  const { category } = req.query;
  const services = category ? getAvailableServices(category) : getAvailableServices();

  const definitions = services.map(key => ({
    key,
    ...SERVICE_DEFINITIONS[key],
    // Mark which ones this tenant has already configured
    configured: !!db.prepare('SELECT 1 FROM tenant_api_configs WHERE tenant_id = ? AND service_key = ?')
      .get(req.tenantId, key),
  }));

  res.json({
    categories: getCategories(),
    services: definitions,
  });
});

// ── GET /api/api-integrations/:id — get one configuration
router.get('/:id', requirePermission('settings.manage'), (req, res) => {
  const config = db.prepare('SELECT * FROM tenant_api_configs WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.tenantId);

  if (!config) return res.status(404).json({ error: 'Configuration not found' });

  res.json({
    ...config,
    credentials: maskCredentials(config.service_key, decryptJSON(config.credentials)),
    definition: getServiceDefinition(config.service_key),
  });
});

// ── POST /api/api-integrations — create a new service configuration
router.post('/', requirePermission('settings.manage'), (req, res) => {
  const { serviceKey, label, credentials, testMode, active } = req.body;

  if (!serviceKey) return res.status(400).json({ error: 'serviceKey is required' });

  const definition = getServiceDefinition(serviceKey);
  if (!definition) return res.status(400).json({ error: 'Unknown service: ' + serviceKey });

  // `credentials` was dereferenced without a guard, so POSTing a serviceKey with no
  // credentials object threw a TypeError and returned a bare 500 instead of a
  // usable validation error.
  if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) {
    return res.status(400).json({ error: 'credentials must be an object of { credentialKey: value }' });
  }

  // Validate required credentials
  const missing = definition.credentials
    .filter(c => c.required && !credentials[c.key])
    .map(c => c.label);

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required credentials: ' + missing.join(', '),
    });
  }

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM tenant_api_configs WHERE tenant_id = ? AND service_key = ?')
    .get(req.tenantId, serviceKey);

  if (existing) {
    return res.status(409).json({
      error: 'This service is already configured. Use PATCH to update it.',
      existingId: existing.id,
    });
  }

  const id = 'apic_' + nanoid(10);
  db.prepare(`INSERT INTO tenant_api_configs
              (id, tenant_id, service_key, category, label, credentials, test_mode, active)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, serviceKey, definition.category, label || definition.name,
         encryptJSON(credentials), testMode ? 1 : 0, active ? 1 : 0);

  const created = db.prepare('SELECT * FROM tenant_api_configs WHERE id = ?').get(id);
  audit(req, 'api_integration.create', 'api_integration', id, { serviceKey, category: definition.category });

  res.status(201).json({
    ...created,
    credentials: maskCredentials(serviceKey, credentials),
    definition,
  });
});

// ── PATCH /api/api-integrations/:id — update credentials or settings
router.patch('/:id', requirePermission('settings.manage'), (req, res) => {
  const config = db.prepare('SELECT * FROM tenant_api_configs WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.tenantId);

  if (!config) return res.status(404).json({ error: 'Configuration not found' });

  const { label, credentials, testMode, active } = req.body;
  const definition = getServiceDefinition(config.service_key);

  // Merge credentials (allow partial updates)
  let updatedCreds = decryptJSON(config.credentials);
  if (credentials) {
    updatedCreds = { ...updatedCreds, ...credentials };

    // Validate required credentials are still present
    const missing = definition.credentials
      .filter(c => c.required && !updatedCreds[c.key])
      .map(c => c.label);

    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Missing required credentials: ' + missing.join(', '),
      });
    }
  }

  const updates = {};
  if (label !== undefined) updates.label = label;
  if (credentials !== undefined) updates.credentials = encryptJSON(updatedCreds);
  if (testMode !== undefined) updates.test_mode = testMode ? 1 : 0;
  if (active !== undefined) updates.active = active ? 1 : 0;
  updates.updated_at = new Date().toISOString();

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tenant_api_configs SET ${setClause} WHERE id = @id`).run({ ...updates, id: config.id });

  const updated = db.prepare('SELECT * FROM tenant_api_configs WHERE id = ?').get(config.id);
  audit(req, 'api_integration.update', 'api_integration', config.id, { updates: Object.keys(updates) });

  res.json({
    ...updated,
    credentials: maskCredentials(config.service_key, updatedCreds),
    definition,
  });
});

// ── POST /api/api-integrations/:id/test — test the connection with stored credentials
router.post('/:id/test', requirePermission('settings.manage'), async (req, res) => {
  const config = db.prepare('SELECT * FROM tenant_api_configs WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.tenantId);

  if (!config) return res.status(404).json({ error: 'Configuration not found' });

  const credentials = decryptJSON(config.credentials);
  const result = await testConnection(config.service_key, credentials, !!config.test_mode);

  // Persist the outcome so the config UI can surface health at a glance.
  if (result.success) {
    db.prepare(`UPDATE tenant_api_configs
                SET last_verified_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
                WHERE id = ?`)
      .run(config.id);
  } else {
    db.prepare(`UPDATE tenant_api_configs
                SET last_error = ?, updated_at = datetime('now')
                WHERE id = ?`)
      .run(String(result.error || 'Connection test failed').slice(0, 500), config.id);
  }

  audit(req, 'api_integration.test', 'api_integration', config.id, {
    serviceKey: config.service_key, success: result.success, tested: result.tested,
  });

  res.status(result.success ? 200 : 400).json({ ...result, testedAt: new Date().toISOString() });
});

// ── DELETE /api/api-integrations/:id — remove a service configuration
router.delete('/:id', requirePermission('settings.manage'), (req, res) => {
  const config = db.prepare('SELECT * FROM tenant_api_configs WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.tenantId);

  if (!config) return res.status(404).json({ error: 'Configuration not found' });

  db.prepare('DELETE FROM tenant_api_configs WHERE id = ?').run(config.id);
  audit(req, 'api_integration.delete', 'api_integration', config.id, { serviceKey: config.service_key });

  res.json({ success: true, message: 'Configuration removed' });
});

// ── Helper: mask sensitive credential values in responses ──
function maskCredentials(serviceKey, credentials) {
  const definition = getServiceDefinition(serviceKey);
  if (!definition) return credentials;

  const masked = {};
  for (const [key, value] of Object.entries(credentials || {})) {
    const credDef = definition.credentials.find(c => c.key === key);
    // Only show public credentials in full; mask everything else
    if (credDef && credDef.public) {
      masked[key] = value;
    } else if (value) {
      // `value.slice` assumed a string — a numeric or boolean credential threw.
      const s = String(value);
      // Short secrets must not leak most of themselves to a 4+4 reveal.
      masked[key] = s.length <= 12 ? '***' : s.slice(0, 4) + '***' + s.slice(-4);
    }
  }
  return masked;
}

module.exports = router;
