// public/js/api.js
// Thin fetch wrapper. Cookies (httpOnly JWT) are sent automatically with
// credentials:'include'. On 401, attempts one silent refresh before failing.

const API = (() => {
  let refreshing = null;
  // When the server rate-limits the refresh endpoint (429), retrying the next
  // request just burns the retry budget and keeps the app 'offline'. Back off
  // hard for a while; show the user a clear message instead of a blank console.
  let refreshBackoffUntil = 0;

  // ── Dead-session handoff ──────────────
  // If a 401 survives even after a (declined) refresh, the refresh cookie is
  // gone/revoked: the shell is “half-alive” — it still shows App.user, so the
  // user stares at a dataless console saying 'Not authenticated' with no way
  // forward. Hand off to the login screen instead, at most once per 30s so a
  // burst of parallel calls doesn't spam the toast.
  function handoffToLogin() {
    if (handoffToLogin._until && Date.now() < handoffToLogin._until) return;
    handoffToLogin._until = Date.now() + 30 * 1000;
    const A = window.App;
    if (!A || !A.user) return;
    A.user = null; A.tenantId = null; A.tenant = null;
    A.permissions = []; A.accessToken = null; A.entitlements = null;
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('visible');
    const authEl = document.getElementById('auth-screen');
    if (authEl) authEl.style.display = '';
    if (typeof WSClient !== 'undefined') WSClient.disconnect();
    if (typeof toast === 'function') toast('Your session has expired — please sign in again.', 'warn', 12000);
  }

  async function request(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const qs = opts.tenantId ? `${path.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(opts.tenantId)}` : '';

    // ── Offline-first (PWA outbox) ─────────────────────────────────────────
    // Call sites opt in with { offline: true, label: '…' }. Such a write is
    // never lost: if the device is offline — or the connection dies
    // mid-flight (navigator.onLine can lie; captive portals still report
    // 'online') — the request is queued in IndexedDB by window.Offline and
    // replayed later with an Idempotency-Key the server executes exactly
    // once (server/middleware/idempotency.js). The call site receives
    // { __offlineQueued: true } and shows honest "saved offline" UI instead
    // of pretending the data reached the server. Requests WITHOUT the flag
    // behave exactly as before this feature existed.
    const offlineCapable = opts.offline === true && (method === 'POST' || method === 'PATCH' || method === 'PUT');
    const OfflineMod = (typeof window !== 'undefined' && window.Offline) ? window.Offline : null;
    const idemKey = offlineCapable && OfflineMod ? OfflineMod.newKey() : null;
    const queueIt = async () => {
      const item = await OfflineMod.enqueue({ method, path, body, label: opts.label, key: idemKey || OfflineMod.newKey() });
      try { window.dispatchEvent(new CustomEvent('staychat:offline-enqueued')); } catch (e) { /* non-fatal */ }
      return { __offlineQueued: true, __outboxId: item.id, __label: item.label };
    };

    if (offlineCapable && OfflineMod && typeof navigator !== 'undefined' && !navigator.onLine) {
      try { return await queueIt(); } catch (e) { /* store broken → fall through to fetch (will throw) */ }
    }
    if (idemKey) headers['Idempotency-Key'] = idemKey;

    let res;
    try {
      res = await fetch(path + qs, {
        method,
        headers,
        credentials: 'include',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (networkErr) {
      // Connection died mid-request. Queue it — the Idempotency-Key already
      // sent guarantees the replay cannot double-execute even if the server
      // DID receive this attempt but the response was lost.
      if (offlineCapable && OfflineMod) {
        try { return await queueIt(); } catch (e) { /* fall through */ }
      }
      throw networkErr;
    }

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
      // Refresh could not recover the session → truly dead. Return to login
      // instead of leaving a shell that renders pages full of 401s.
      handoffToLogin();
    }

    // Maintenance-mode 503 is answered by global middleware BEFORE any route
    // runs — the request definitely did not execute, so it is safe to queue
    // and replay once maintenance ends (flush treats a repeat 503 as a
    // server error with backoff, so this can never hot-loop).
    if (offlineCapable && OfflineMod && res.status === 503) {
      try { return await queueIt(); } catch (e) { /* fall through to normal handling */ }
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
