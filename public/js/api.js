// public/js/api.js
// Thin fetch wrapper. Cookies (httpOnly JWT) are sent automatically with
// credentials:'include'. On 401, attempts one silent refresh before failing.

const API = (() => {
  let refreshing = null;
  // When the server rate-limits the refresh endpoint (429), retrying the next
  // request just burns the retry budget and keeps the app 'offline'. Back off
  // hard for a while; show the user a clear message instead of a blank console.
  let refreshBackoffUntil = 0;

  // ── Session refresh — the ONE code path that may call /api/auth/refresh ───
  // api.js (401 retry), auth.js (boot restore), ws-client.js (WS 4001) and
  // offline.js (outbox replay) all used to keep their OWN refresh routine.
  // The refresh cookie is single-use server-side and the rotation guard
  // revokes EVERY session for the user the moment it is presented twice, so
  // any two of those racing — which happens on nearly every page load, since
  // the boot restore and the first 401-triggered retry overlap — silently
  // signed the whole hotel out. They now share one in-flight promise, and an
  // exclusive Web Lock serialises it ACROSS tabs (a second tab refreshing at
  // the same instant used to do the same damage).
  //
  // Returns a tri-state so callers can tell a dead session from a dead network:
  //   { status: 'ok', data }         session rotated — data published to App
  //   { status: 'unauthorized' }     server says the session is gone for good
  //   { status: 'unavailable' }      offline / 429 / 5xx — NOT the user's fault

  function publishSession(data) {
    if (!data || typeof window === 'undefined' || !window.App) return;
    if (data.accessToken) window.App.accessToken = data.accessToken;
    if (data.user) window.App.user = data.user;
    if (data.tenant) window.App.tenant = data.tenant;
    if (data.entitlements) window.App.entitlements = data.entitlements;
  }

  // Cross-tab mutex. Falls back to running directly where Web Locks is
  // unsupported (older Safari) — the in-flight promise still serialises
  // everything inside this tab.
  function withRefreshLock(fn) {
    if (typeof navigator !== 'undefined' && navigator.locks &&
        typeof navigator.locks.request === 'function') {
      return navigator.locks.request('staychat.session-refresh', { mode: 'exclusive' }, fn);
    }
    return fn();
  }

  function refreshSession() {
    if (refreshing) return refreshing;
    if (Date.now() < refreshBackoffUntil) {
      return Promise.resolve({ status: 'unavailable', reason: 'rate-limited' });
    }
    // Known-offline: don't sit on a fetch that cannot succeed (and never let
    // it be mistaken for a rejected session — see the catch below).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return Promise.resolve({ status: 'unavailable', reason: 'offline' });
    }
    refreshing = withRefreshLock(async () => {
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
          return { status: 'unavailable', reason: 'rate-limited' };
        }
        if (res.status === 401 || res.status === 403) {
          refreshBackoffUntil = 0;
          return { status: 'unauthorized' };
        }
        refreshBackoffUntil = 0;
        if (!res.ok) return { status: 'unavailable', reason: 'HTTP ' + res.status };
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!data || !data.accessToken) return { status: 'unavailable', reason: 'bad-payload' };
        publishSession(data);
        return { status: 'ok', data };
      } catch (e) {
        // fetch only throws when the connection itself died — the cookie may
        // be perfectly valid, so this must never be read as "logged out".
        return { status: 'unavailable', reason: 'network' };
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    }).catch(() => ({ status: 'unavailable', reason: 'lock' })); // lock machinery itself failing
    return refreshing;
  }

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
    // The server has ruled the session dead — the offline boot snapshot must
    // not resurrect it on the next reload (defined in auth.js).
    if (typeof clearSessionSnapshot === 'function') clearSessionSnapshot();
    const appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('visible');
    const authEl = document.getElementById('auth-screen');
    if (authEl) authEl.style.display = '';
    if (typeof WSClient !== 'undefined') WSClient.disconnect();
    if (typeof toast === 'function') toast('Your session has expired — please sign in again.', 'warn', 12000);
  }

  // ── In-flight coalescing (steady hands on a bad network) ──────────────────
  // Identical requests still in flight SHARE one promise: a double-click while
  // the network is slow ("nothing happened — click again") can no longer fire
  // a duplicate write. Once the first settles, the next click is fresh.
  // Internal retries (401 refresh, 429 backoff) bypass this map — they await
  // their own nested promise, never this wrapper's.
  const inflight = new Map();

  async function request(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const qs = opts.tenantId ? `${path.includes('?') ? '&' : '?'}tenantId=${encodeURIComponent(opts.tenantId)}` : '';
    const rawKey = method + '\u0000' + path + qs + '\u0000' + (body === undefined ? '' : JSON.stringify(body));
    const isRetry = opts._isRetry === true || opts._is429Retry === true;
    if (!isRetry && inflight.has(rawKey)) return inflight.get(rawKey);
    const run = (async () => {

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
      const r = await refreshSession();
      if (r.status === 'ok') {
        // refreshSession already published the fresh user/tenant/token to
        // window.App, so the WebSocket client and anything else reading
        // window.App.accessToken sees the new token.
        return request(method, path, body, { ...opts, _isRetry: true });
      }
      // ONLY a definitive server-side 'no session' may end the session.
      // 'unavailable' (server restarting, 429, connection flapping) used to
      // land here too and wipe App.user — that is what threw a working desk
      // back to the sign-in form mid-shift for no reason.
      if (r.status === 'unauthorized') handoffToLogin();
      // otherwise: fall through, surface the 401 to THIS caller, keep the
      // session alive — the retry succeeds once the server answers again.
    }

    // ── 429: back off, then retry a GET once ─────────────────────────────────
    // Many users behind one IP can push the per-minute limiter. Reads are safe
    // to retry after a short pause; writes never auto-retry (replaying a write
    // blindly can double-execute it) — they surface the throttled toast below.
    if (res.status === 429 && method === 'GET' && !opts._is429Retry) {
      await new Promise(r => setTimeout(r, 1800));
      return request(method, path, body, { ...opts, _is429Retry: true });
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
      // One calm heads-up per burst instead of a toast storm when the limiter
      // pushes back (many users on one IP / a busy server).
      if (res.status === 429 && typeof toast === 'function') {
        const now = Date.now();
        if (!request._last429 || now - request._last429 > 8000) {
          request._last429 = now;
          toast('The server is busy — hold on a moment and try again.', 'warn', 4000);
        }
      }
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
    })();
    if (!isRetry) inflight.set(rawKey, run);
    try { return await run; } finally { if (!isRetry) inflight.delete(rawKey); }
  }

  const tenantQS = () => (window.App && window.App.tenantId ? { tenantId: window.App.tenantId } : {});

  return {
    get: (path, opts) => request('GET', path, undefined, { ...tenantQS(), ...opts }),
    post: (path, body, opts) => request('POST', path, body, { ...tenantQS(), ...opts }),
    put: (path, body, opts) => request('PUT', path, body, { ...tenantQS(), ...opts }),
    patch: (path, body, opts) => request('PATCH', path, body, { ...tenantQS(), ...opts }),
    del: (path, opts) => request('DELETE', path, undefined, { ...tenantQS(), ...opts }),
    raw: request,
    // Shared session refresh — see the block at the top of this file.
    refreshSession,
    handoffToLogin,
    // Same URL the app itself will ask for, so a warmed cache entry is hit
    // byte-for-byte when the page later renders offline.
    cacheUrl: (path) => {
      const t = (typeof window !== 'undefined' && window.App && window.App.tenantId) ? window.App.tenantId : null;
      if (!t) return path;
      return path + (path.includes('?') ? '&' : '?') + 'tenantId=' + encodeURIComponent(t);
    },
  };
})();
