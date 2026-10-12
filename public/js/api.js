// public/js/api.js
// Thin fetch wrapper. Cookies (httpOnly JWT) are sent automatically with
// credentials:'include'. On 401, attempts one silent refresh before failing.

const API = (() => {
  let refreshing = null;
  // When the server rate-limits the refresh endpoint (429), retrying the next
  // request just burns the retry budget and keeps the app 'offline'. Back off
  // hard for a while; show the user a clear message instead of a blank console.
  let refreshBackoffUntil = 0;

  async function request(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const qs = opts.tenantId ? `${path.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(opts.tenantId)}` : '';

    const res = await fetch(path + qs, {
      method,
      headers,
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && !opts._isRetry && path !== '/api/auth/login' && path !== '/api/auth/refresh') {
      const ok = await tryRefresh();
      if (ok) {
        // Keep the in-memory access token in sync so the WebSocket client and
        // anything else reading window.App.accessToken sees the fresh token.
        // (The /api/auth/refresh response carries the new accessToken.)
        try {
          if (typeof window !== 'undefined' && window.App && window.App._lastRefresh) {
            window.App.accessToken = window.App._lastRefresh.accessToken || window.App.accessToken;
            if (window.App._lastRefresh.user) window.App.user = window.App._lastRefresh.user;
            if (window.App._lastRefresh.tenant) window.App.tenant = window.App._lastRefresh.tenant;
            if (window.App._lastRefresh.entitlements) window.App.entitlements = window.App._lastRefresh.entitlements;
          }
        } catch (e) { /* non-fatal */ }
        return request(method, path, body, { ...opts, _isRetry: true });
      }
    }

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }

    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      // SaaS entitlement gating: surface the platform's upgrade UI instead of a
      // dead-end error whenever the server answers 402 — or 403 with the
      // machine-readable SUSPENDED code (expired trial / cancelled sub).
      if (data && ['UPGRADE_REQUIRED', 'PLAN_LIMIT_REACHED', 'SUSPENDED'].includes(data.code) &&
          [402, 403].includes(res.status) && typeof window !== 'undefined') {
        if (typeof window.openUpgradeModal === 'function') {
          setTimeout(() => window.openUpgradeModal(data), 0);
        }
      }
      throw err;
    }
    return data;
  }

  async function tryRefresh() {
    if (refreshing) return refreshing;
    if (Date.now() < refreshBackoffUntil) return false;
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.status === 429) {
          // Rate-limited: sit out a chunk of the limiter's window instead of
          // re-arming the cycle on every keystroke (which is what made the
          // lockout stick).
          refreshBackoffUntil = Date.now() + 60 * 1000;
          if (typeof toast === 'function' && window.App && window.App.user) {
            toast('Session updates are paused — the server is busy. Your work is safe; try again in a minute.', 'warn', 8000);
          }
          return false;
        }
        refreshBackoffUntil = 0;
        if (!res.ok) return false;
        // Cache the refreshed session so request() can publish it to window.App.
        const text = await res.text();
        try { window.App._lastRefresh = text ? JSON.parse(text) : null; } catch (e) { window.App._lastRefresh = null; }
        return true;
      } catch (e) {
        return false;
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
    return refreshing;
  }

  const tenantQS = () => (window.App && window.App.tenantId ? { tenantId: window.App.tenantId } : {});

  return {
    get: (path, opts) => request('GET', path, undefined, { ...tenantQS(), ...opts }),
    post: (path, body, opts) => request('POST', path, body, { ...tenantQS(), ...opts }),
    put: (path, body, opts) => request('PUT', path, body, { ...tenantQS(), ...opts }),
    patch: (path, body, opts) => request('PATCH', path, body, { ...tenantQS(), ...opts }),
    del: (path, opts) => request('DELETE', path, undefined, { ...tenantQS(), ...opts }),
    raw: request,
  };
})();
