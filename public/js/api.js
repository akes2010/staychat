// public/js/api.js
// Thin fetch wrapper. Cookies (httpOnly JWT) are sent automatically with
// credentials:'include'. On 401, attempts one silent refresh before failing.

const API = (() => {
  let refreshing = null;

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
      if (ok) return request(method, path, body, { ...opts, _isRetry: true });
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
    refreshing = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        return res.ok;
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
