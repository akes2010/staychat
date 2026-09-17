// server/utils/http-client.js
// Shared, dependency-free helpers for outbound calls to third-party APIs
// (network controllers, door locks, IPTV platforms). Every request is wrapped
// with a hard timeout so a dead endpoint can never wedge a request handler.
'use strict';

const net = require('net');

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * JSON-oriented HTTP request with a hard timeout.
 * @returns {Promise<{status:number, ok:boolean, text:string, json:object|null}>}
 */
async function request(method, url, { headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON body is fine */ }
    return { status: res.status, ok: res.ok, text, json, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TCP reachability probe (host up / path open). Used for self-hosted gear
 * where a credential-validating cloud endpoint doesn't exist.
 */
function tcpProbe(host, port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ reachable: true }));
    socket.once('timeout', () => done({ reachable: false, error: `No response from ${host}:${port} within ${timeoutMs / 1000}s` }));
    socket.once('error', (e) => done({ reachable: false, error: e.message }));
    socket.connect(port, host);
  });
}

module.exports = { request, tcpProbe, DEFAULT_TIMEOUT_MS };
