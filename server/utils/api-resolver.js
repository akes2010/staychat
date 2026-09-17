// server/utils/api-resolver.js
// Runtime resolver for external API credentials.
// When a feature needs to talk to a third-party service (charge a card, sync an
// OTA rate, send an SMS), it calls one of these helpers to get the tenant's
// active, fully-unmasked credentials — or a clear signal that the service isn't
// configured yet. This is the single seam between "config stored in the DB" and
// "code that makes the outbound call," so wiring real APIs later touches only the
// per-service adapter, never every call site.
'use strict';

const db = require('../db/connection');
const { getServiceDefinition } = require('../config/api-services');
const { decryptJSON } = require('./crypto-store');

/**
 * Get the active configuration for a specific service, with real credentials.
 * Returns null if the service is not configured or not active for this tenant.
 *
 * @param {string} tenantId
 * @param {string} serviceKey  e.g. 'stripe', 'twilio', 'booking_com'
 * @returns {{ serviceKey, category, credentials, testMode, definition } | null}
 */
function getServiceConfig(tenantId, serviceKey) {
  const row = db.prepare(`
    SELECT * FROM tenant_api_configs
    WHERE tenant_id = ? AND service_key = ? AND active = 1
  `).get(tenantId, serviceKey);

  if (!row) return null;

  return {
    id: row.id,
    serviceKey: row.service_key,
    category: row.category,
    label: row.label,
    credentials: decryptJSON(row.credentials),
    testMode: !!row.test_mode,
    baseUrl: resolveBaseUrl(row.service_key, decryptJSON(row.credentials)),
    definition: getServiceDefinition(row.service_key),
  };
}

/**
 * Get the first active service in a category (e.g. the tenant's chosen payment
 * gateway, or their SMS provider). Useful when a feature doesn't care WHICH
 * provider, only that one is configured. Returns null if none are active.
 *
 * @param {string} tenantId
 * @param {string} category  e.g. 'payment_gateway', 'sms_provider', 'email_provider'
 * @returns {object | null}
 */
function getActiveServiceInCategory(tenantId, category) {
  const row = db.prepare(`
    SELECT * FROM tenant_api_configs
    WHERE tenant_id = ? AND category = ? AND active = 1
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(tenantId, category);

  if (!row) return null;
  return getServiceConfig(tenantId, row.service_key);
}

/**
 * List all active services in a category (e.g. all enabled payment gateways so
 * the checkout UI can offer a choice).
 *
 * @param {string} tenantId
 * @param {string} category
 * @returns {object[]}
 */
function getActiveServicesInCategory(tenantId, category) {
  const rows = db.prepare(`
    SELECT service_key FROM tenant_api_configs
    WHERE tenant_id = ? AND category = ? AND active = 1
    ORDER BY updated_at DESC
  `).all(tenantId, category);

  return rows.map(r => getServiceConfig(tenantId, r.service_key)).filter(Boolean);
}

/**
 * Check whether a service is configured & active without pulling credentials.
 */
function isServiceActive(tenantId, serviceKey) {
  return !!db.prepare(`
    SELECT 1 FROM tenant_api_configs
    WHERE tenant_id = ? AND service_key = ? AND active = 1
  `).get(tenantId, serviceKey);
}

/**
 * Resolve a base URL, substituting any {placeholder} tokens (e.g. {region})
 * from the credential values. Falls back to the definition's static baseUrl.
 */
function resolveBaseUrl(serviceKey, credentials) {
  const def = getServiceDefinition(serviceKey);
  if (!def || !def.baseUrl) return null;

  return def.baseUrl.replace(/\{(\w+)\}/g, (match, token) => credentials[token] || match);
}

/**
 * Record the outcome of an outbound call attempt so the config UI can surface
 * health. Non-throwing — telemetry must never break the calling feature.
 */
function recordServiceResult(configId, ok, errorMessage) {
  try {
    if (ok) {
      db.prepare(`UPDATE tenant_api_configs
                  SET last_verified_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
                  WHERE id = ?`).run(configId);
    } else {
      db.prepare(`UPDATE tenant_api_configs
                  SET last_error = ?, updated_at = datetime('now')
                  WHERE id = ?`).run(String(errorMessage || 'Unknown error').slice(0, 500), configId);
    }
  } catch (e) { /* telemetry must never throw */ }
}

module.exports = {
  getServiceConfig,
  getActiveServiceInCategory,
  getActiveServicesInCategory,
  isServiceActive,
  resolveBaseUrl,
  recordServiceResult,
};
