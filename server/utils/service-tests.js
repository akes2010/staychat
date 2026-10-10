// server/utils/service-tests.js
// Real, read-only connection tests for configured external services.
//
// Each test makes ONE lightweight, side-effect-free call that proves the
// credentials authenticate — never a call that moves money, sends a message, or
// mutates remote state. A test either resolves `{ success: true, message }` or
// `{ success: false, error }`. Anything we don't have a specific probe for
// falls back to a credential-shape check so the UI still gives useful feedback.
'use strict';

const net = require('net');
const { getServiceDefinition } = require('../config/api-services');

// Abort any probe that hangs so a dead endpoint can't wedge the request.
const TIMEOUT_MS = 8000;

async function httpGet(url, headers) {
  return httpReq('GET', url, headers, null);
}

async function httpReq(method, url, headers, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function ok(message) { return { success: true, message }; }
function fail(error) { return { success: false, error }; }

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── Per-service probes ────────────────────────────────────────────────────
// Keyed by service_key. Each returns a normalized {success,...} result.
const PROBES = {
  // Stripe — list balance is read-only and needs only the secret key.
  async stripe(c) {
    const r = await httpGet('https://api.stripe.com/v1/balance', {
      Authorization: 'Bearer ' + c.secret_key,
    });
    if (r.ok) return ok('Authenticated with Stripe');
    return fail(r.json?.error?.message || `Stripe returned HTTP ${r.status}`);
  },

  // Paystack — verify the secret key against a read endpoint.
  async paystack(c) {
    const r = await httpGet('https://api.paystack.co/transaction?perPage=1', {
      Authorization: 'Bearer ' + c.secret_key,
    });
    if (r.ok) return ok('Authenticated with Paystack');
    return fail(r.json?.message || `Paystack returned HTTP ${r.status}`);
  },

  // Flutterwave — read-only balances endpoint validates the secret key.
  async flutterwave(c) {
    const r = await httpGet('https://api.flutterwave.com/v3/balances', {
      Authorization: 'Bearer ' + c.secret_key,
    });
    if (r.ok) return ok('Authenticated with Flutterwave');
    return fail(r.json?.message || `Flutterwave returned HTTP ${r.status}`);
  },

  // Twilio — fetch the account resource; proves SID + auth token.
  async twilio(c) {
    const r = await httpGet(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.account_sid)}.json`,
      { Authorization: basicAuth(c.account_sid, c.auth_token) }
    );
    if (r.ok) return ok('Authenticated with Twilio');
    return fail(r.json?.message || `Twilio returned HTTP ${r.status}`);
  },

  // SendGrid — scopes endpoint is read-only and validates the API key.
  async sendgrid(c) {
    const r = await httpGet('https://api.sendgrid.com/v3/scopes', {
      Authorization: 'Bearer ' + c.api_key,
    });
    if (r.ok) return ok('Authenticated with SendGrid');
    return fail(r.json?.errors?.[0]?.message || `SendGrid returned HTTP ${r.status}`);
  },

  // Mailgun — list domains; validates the private API key.
  async mailgun(c) {
    const r = await httpGet('https://api.mailgun.net/v4/domains?limit=1', {
      Authorization: basicAuth('api', c.api_key),
    });
    if (r.ok) return ok('Authenticated with Mailgun');
    return fail(r.json?.message || `Mailgun returned HTTP ${r.status}`);
  },

  // Resend — list API keys; read-only, validates the key.
  async resend(c) {
    const r = await httpGet('https://api.resend.com/api-keys', {
      Authorization: 'Bearer ' + c.api_key,
    });
    if (r.ok) return ok('Authenticated with Resend');
    return fail(r.json?.message || `Resend returned HTTP ${r.status}`);
  },

  // Cloudinary — ping endpoint using key/secret basic auth.
  async cloudinary(c) {
    const r = await httpGet(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(c.cloud_name)}/ping`,
      { Authorization: basicAuth(c.api_key, c.api_secret) }
    );
    if (r.ok) return ok('Authenticated with Cloudinary');
    return fail(r.json?.error?.message || `Cloudinary returned HTTP ${r.status}`);
  },

  // OneSignal — view the app; validates app_id + REST API key.
  async onesignal(c) {
    const r = await httpGet(
      `https://onesignal.com/api/v1/apps/${encodeURIComponent(c.app_id)}`,
      { Authorization: 'Basic ' + c.rest_api_key }
    );
    if (r.ok) return ok('Authenticated with OneSignal');
    return fail(r.json?.errors?.[0] || `OneSignal returned HTTP ${r.status}`);
  },

  // ── Door locks ──────────────────────────────────────────────────────────
  // Seam — list devices; read-only, validates the API key.
  async seam(c) {
    const r = await httpGet('https://connect.getseam.com/devices/list?limit=1', {
      Authorization: 'Bearer ' + c.api_key,
    });
    if (r.ok) return ok('Authenticated with Seam (' + (r.json?.devices?.length ?? '?') + ' device(s) visible)');
    return fail(r.json?.error?.message || `Seam returned HTTP ${r.status}`);
  },

  // TTLock — OAuth token request is the only credential-validation endpoint.
  // Read-only in effect: it issues a token but changes nothing.
  async ttlock(c) {
    const r = await httpReq('POST', 'https://api.ttlock.com/v3/oauth2/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({
        client_id: c.client_id, client_secret: c.client_secret,
        username: c.username, password: c.password, grant_type: 'password',
      }).toString());
    if (r.ok && r.json?.access_token) return ok('TTLock credentials valid (token issued)');
    return fail(r.json?.error_description || r.json?.errmsg || `TTLock returned HTTP ${r.status}`);
  },

  // RemoteLock — list locks; read-only, validates the OAuth token.
  async remotelock(c) {
    const r = await httpGet('https://api.remotelock.com/locks?per_page=1', {
      Authorization: 'Bearer ' + c.access_token,
      Accept: 'application/json',
    });
    if (r.ok) return ok('Authenticated with RemoteLock');
    return fail(r.json?.message || `RemoteLock returned HTTP ${r.status}`);
  },

  // ── IPTV / VOD ─────────────────────────────────────────────────────
  // Samsung LYNK Cloud — tenant-scoped device list; validates API key + tenant.
  async samsung_lynk(c) {
    const r = await httpGet(
      `https://sdk.samsungcloudsolution.net/lynk/api/v1/tenants/${encodeURIComponent(c.tenant_id)}/devices?size=1`,
      { apikey: c.api_key }
    );
    if (r.ok) return ok('Authenticated with Samsung LYNK Cloud');
    return fail(r.json?.error?.message || `Samsung LYNK returned HTTP ${r.status}`);
  },

  // ── Internet management ─────────────────────────────────────────────
  // Meraki — read-only org list validates the dashboard API key.
  async meraki(c) {
    const r = await httpGet('https://api.meraki.com/api/v1/organizations', {
      'X-Cisco-Meraki-API-Key': c.api_key,
    });
    if (r.ok) return ok('Authenticated with Meraki (' + (Array.isArray(r.json) ? r.json.length : '?') + ' org(s))');
    return fail(r.json?.errors?.[0] || `Meraki returned HTTP ${r.status}`);
  },

  // Sonos — the token endpoint rejects bad client credentials; validating only.
  async sonos(c) {
    const r = await httpReq('POST', 'https://api.sonos.com/login/v3/oauth/access/token',
      { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth(c.client_id, c.client_secret) },
      'grant_type=client_credentials');
    if (r.ok && r.json?.access_token) return ok('Sonos client credentials valid');
    return fail(r.json?.error_description || `Sonos returned HTTP ${r.status}`);
  },
};

// Self-hosted / on-prem services have no cloud credential endpoint to probe.
// A TCP reachability check still tells the user whether the host is up and
// the network path is open — far more useful than an untested green tick.
const SELF_HOSTED_PROBES = {
  assa_abloy_vingcard: async (c) => tcpProbe(c.server_url),
  salto_systems: async (c) => tcpProbe(c.server_url),
  zkteco: async (c) => tcpProbe(c.device_host, c.device_port),
  onity: async (c) => tcpProbe(c.gateway_url),
  dormakaba: async (c) => tcpProbe(c.gateway_url),
  mwaretv: async (c) => tcpProbe(c.platform_url),
  hottv_vod: async (c) => tcpProbe(c.server_host, c.server_port),
  alphaott: async (c) => tcpProbe(c.platform_url),
  vitec: async (c) => tcpProbe(c.server_host),
  lg_procentric: async (c) => tcpProbe(c.server_host),
  unifi: async (c) => tcpProbe(c.controller_url),
  mikrotik: async (c) => tcpProbe(c.router_host, c.router_port),
  omada: async (c) => tcpProbe(c.controller_url),
  ruckus: async (c) => tcpProbe(c.controller_url),
  control4: async (c) => tcpProbe(c.director_url),
  crestron: async (c) => tcpProbe(c.processor_url),
  knx: async (c) => tcpProbe(c.gateway_host, c.gateway_port),
  lutron: async (c) => tcpProbe(c.processor_host),
  philips_hue: async (c) => tcpProbe(c.bridge_host),
  // Zigbee / IoT & camera APIs — all on-prem, validated on first real use.
  zigbee: async (c) => tcpProbe(c.gateway_host, c.gateway_port),
  hikvision: async (c) => tcpProbe(c.device_host, c.device_port),
  dahua: async (c) => tcpProbe(c.device_host, c.device_port),
  iot_platform: async (c) => tcpProbe(c.platform_url),
};

function parseHostPort(raw, fallbackPort) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // Leading-colon IPv6 literals ('::1', 'fd00::5' — with or without a scheme)
  // make the generic regex capture the scheme/first segment as the host.
  // Detect them explicitly: everything up to the LAST ':' before a digit-tail
  // is the address; a trailing ':<digits>' after ']' or the final ':' is the port.
  const stripScheme = s.replace(/^https?:\/\//i, '');
  if (stripScheme.startsWith(':') || /^\[[0-9a-f:]+\]/i.test(stripScheme)) {
    const useTls = /^https:/i.test(s);
    // Bracketed literal: '[::1]:8443' → addr='::1', port=8443 ; '[fd00::5]' → port=fallback
    const bracket = stripScheme.match(/^\[([0-9a-f:]+)\](?::(\d+))?$/i);
    if (bracket) {
      return { host: bracket[1], port: bracket[2] ? Number(bracket[2]) : (useTls ? 443 : fallbackPort), useTls };
    }
    // Bare (unbracketed) IPv6: '::1' or 'fd00::5'. A trailing ':<digits>' segment
    // after the final colon is ambiguous in bare IPv6 (no brackets), so for safety
    // we treat the whole string as the ADDRESS — the port stays the fallback.
    // (Hotels entering IPv6 without brackets get port 80/443 — acceptable.)
    return { host: stripScheme, port: useTls ? 443 : fallbackPort, useTls };
  }
  const m = s.match(/^(?:https?:\/\/)?([^/:\s]+)(?::(\d+))?/i);
  if (!m) return null;
  const useTls = useTlsOf(s);
  return { host: m[1], port: m[2] ? Number(m[2]) : (useTls ? 443 : fallbackPort), useTls };
}

function useTlsOf(s) { return /^https:/i.test(s); }

// True for hostnames/IPs the server must not dial on behalf of a tenant:
// loopback (incl. metadata 169.254.169.254), RFC1918 private ranges, IPv6
// loopback/ULA/link-local, cloud metadata hostnames, and bare IP literals
// in those ranges. Public DNS names pass through (resolving them to a private
// address is a DNS-rebinding risk accepted here because the probe is
// read-only TCP connect with an 8s timeout).
function isPrivateOrLocalHost(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal' || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;              // 0.x, 10/8, 127/8
    if (a === 169 && b === 254) return true;                        // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16/12
    if (a === 192 && b === 168) return true;                        // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64/10
  }
  if (h.includes(':')) { // IPv6 literal (possibly with stray port text)
    // '[::1]:8443' or '::1:8443' would be garbled by naive suffix checks —
    // the ADDRESS is everything before the final ':<digits-only>' segment.
    const addrPort = h.match(/^(.+):(\d+)$/);
    const addr = (addrPort && !addrPort[1].includes(':\d')) ? addrPort[1] : h;
    const bare = addr.replace(/^\[|\]$/g, '');
    if (bare === '::1' || bare === '::' || bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('::ffff:127.')) return true;
  }
  return false;
}

function tcpProbe(rawUrl, fallbackPort = 80) {
  const target = parseHostPort(rawUrl, fallbackPort);
  // IPv6 literals ('::1', 'fd00::5') don't survive the host regex above —
  // check the RAW string for them before the "could not parse" bail-out.
  if (!target && isPrivateOrLocalHost(String(rawUrl || '').trim())) {
    return Promise.resolve(fail('Refusing to test a private/internal address (' + String(rawUrl).trim() + ') — enter the device\'s public hostname or IP'));
  }
  if (!target) return Promise.resolve(fail('Could not parse host from "' + rawUrl + '"'));
  // SSRF guard: a signed-in hotel admin controls this host string, and the
  // server runs on the same network as its own database/vault. Refuse to dial
  // private ranges, loopback, link-local and the metadata address.
  if (isPrivateOrLocalHost(target.host)) {
    return Promise.resolve(fail('Refusing to test a private/internal address (' + target.host + ') — enter the device\'s public hostname or IP'));
  }
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => done(ok(
      'Host ' + target.host + ':' + target.port + ' is reachable' +
      ' (credentials are validated on first real use)'
    )));
    socket.once('timeout', () => done(fail('No response from ' + target.host + ':' + target.port + ' within ' + TIMEOUT_MS / 1000 + 's')));
    socket.once('error', (e) => done(fail('Cannot reach ' + target.host + ':' + target.port + ' — ' + e.message)));
    socket.connect(target.port, target.host);
  });
}

/**
 * Test a service connection.
 *
 * @param {string} serviceKey
 * @param {object} credentials  decrypted, full credential map
 * @param {boolean} [testMode]  informational; probes hit live endpoints regardless
 * @returns {Promise<{success:boolean, message?:string, error?:string, tested:boolean}>}
 */
async function testConnection(serviceKey, credentials, testMode = false) {
  const definition = getServiceDefinition(serviceKey);
  if (!definition) return fail('Unknown service: ' + serviceKey);

  // Always verify required credentials are present before reaching out.
  const missing = definition.credentials
    .filter(c => c.required && !credentials[c.key])
    .map(c => c.label);

  if (missing.length > 0) {
    return { ...fail('Missing required credentials: ' + missing.join(', ')), tested: false };
  }

  const probe = PROBES[serviceKey] || SELF_HOSTED_PROBES[serviceKey];
  if (!probe) {
    // No live probe for this service yet — the credentials are shape-valid, but
    // be honest that we didn't reach the provider.
    return {
      success: true,
      message: `Credentials look complete. Live connection test isn't available for ${definition.name} yet — they'll be validated on first real use.`,
      tested: false,
    };
  }

  try {
    const result = await probe(credentials);
    return { ...result, tested: true };
  } catch (e) {
    const reason = e?.name === 'AbortError'
      ? `${definition.name} did not respond within ${TIMEOUT_MS / 1000}s`
      : (e?.message || 'Connection failed');
    return { ...fail(reason), tested: true };
  }
}

module.exports = { testConnection };

