// public/js/pwa.js
// PWA glue: registers the service worker, surfaces install prompt + offline
// state, and wipes offline data on logout so a shared front-desk tablet never
// leaks one hotel's cached data to the next shift.
'use strict';

window.PWA = (() => {
  let deferredPrompt = null;
  const listeners = { installable: [], offline: [], update: [] };

  // ── Service worker registration ──────────────────────────────────────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(err => {
        console.warn('Service worker registration failed:', err.message);
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        emit('update');
      });
    });
  }

  function emit(name, detail) { (listeners[name] || []).forEach(fn => { try { fn(detail); } catch (e) {} }); }

  // ── Install prompt (desktop + Android) ────────────────────────────────────
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    emit('installable');
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    try { localStorage.removeItem('staychat.installDismissed'); } catch (e) {}
  });

  async function promptInstall() {
    if (!deferredPrompt) {
      // iOS Safari never fires beforeinstallprompt — teach the gesture.
      const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      if (isIOS) {
        alert('To install StayChat OS on your iPhone/iPad:\n\n1. Tap the Share button (□↑) in Safari\n2. Choose "Add to Home Screen"\n3. Tap Add — StayChat runs full-screen like a native app.');
        return 'ios-instructions';
      }
      toast('Use your browser menu → "Install app" / "Add to Home screen".', 'info', 4000);
      return 'menu-instructions';
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if (outcome === 'dismissed') {
      try { localStorage.setItem('staychat.installDismissed', String(Date.now())); } catch (e) {}
    }
    return outcome;
  }

  // ── Connectivity state ─────────────────────────────────────────────────────
  function online() { return navigator.onLine; }
  window.addEventListener('online', () => {
    emit('offline', false);
    if (typeof toast === 'function') toast('Back online — syncing live data', 'success');
    warmCache(); // refill whatever went stale during the outage
  });
  window.addEventListener('offline', () => { emit('offline', true); if (typeof toast === 'function') toast('You are offline — showing last known data', 'error', 4000); });

  // ── Offline data: pull the whole desk down onto this device ─────────────
  // The service worker only caches an /api/ GET after something has asked for
  // it, so a tablet that never opened (say) Housekeeping had nothing to show
  // when the Wi-Fi died. After sign-in — and again whenever the connection
  // comes back — fetch the core reads once each and drop them into the SW's
  // API cache under the EXACT url the page will later request (same query
  // string, same order), so the offline copy is hit byte-for-byte.
  const CORE_ENDPOINTS = [
    '/api/analytics/summary', '/api/analytics/departments', '/api/analytics/engine',
    '/api/rooms', '/api/room-setup/floors', '/api/room-setup/categories',
    '/api/bookings', '/api/guests', '/api/staff', '/api/orders',
    '/api/menu', '/api/menu/categories', '/api/settings',
    '/api/payments/transactions', '/api/pos/summary', '/api/pos/tickets',
    '/api/inbox/conversations', '/api/shifts', '/api/maintenance',
    '/api/halls/halls', '/api/tables', '/api/printers', '/api/blocklist',
    '/api/misc-services/services', '/api/wifi', '/api/reports/types',
    '/api/gym/gyms', '/api/fitness/plans',
  ];
  const ADMIN_ENDPOINTS = ['/api/users', '/api/users/capabilities', '/api/billing/summary', '/api/billing/usage',
    '/api/accounting/accounts', '/api/api-integrations'];
  const SUPERADMIN_ENDPOINTS = ['/api/superadmin/tenants', '/api/superadmin/overview', '/api/plans/plans'];

  function warmPaths() {
    const App_ = typeof window !== 'undefined' ? window.App : null;
    const role = (App_ && App_.user && App_.user.role) || '';
    let paths = CORE_ENDPOINTS.slice();
    if (role === 'hotel_admin' || role === 'superadmin') paths = paths.concat(ADMIN_ENDPOINTS);
    if (role === 'superadmin' && App_ && !App_.tenantId) paths = SUPERADMIN_ENDPOINTS.slice();
    return paths;
  }

  // The SW's API cache is created lazily by its own fetch handler, so on a
  // brand-new install it may not exist yet when we first sign in. It shares
  // its VERSION suffix with the shell cache, which `install` always creates —
  // derive the name from there so day-one users get offline data too.
  async function findApiCache() {
    const names = await caches.keys();
    const hit = names.filter(n => n.indexOf('staychat-api-') === 0).sort().pop();
    if (hit) return hit;
    const shell = names.filter(n => n.indexOf('staychat-shell-') === 0).sort().pop();
    return shell ? shell.replace('staychat-shell-', 'staychat-api-') : null;
  }

  async function warmCache() {
    if (typeof caches === 'undefined') return 0;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
    // Nobody signed in → every one of these would just be a 401.
    if (!window.App || !App.user) return 0;
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      // Wait for activation: it claims the page and drops superseded caches,
      // so the name we resolve below is the live one.
      try { await navigator.serviceWorker.ready; } catch (e) { /* unsupported */ }
    }
    try {
      const name = await findApiCache();
      if (!name) return 0;
      const cache = await caches.open(name);
      const queue = warmPaths();
      let saved = 0;
      const workers = [];
      for (let i = 0; i < 4 && queue.length; i++) {
        workers.push((async () => {
          while (queue.length) {
            if (typeof navigator !== 'undefined' && !navigator.onLine) return;
            const path = queue.shift();
            try {
              const url = (typeof API !== 'undefined' && API.cacheUrl) ? API.cacheUrl(path) : path;
              const res = await fetch(url, { credentials: 'include' });
              if (res.ok) { await cache.put(url, res.clone()); saved++; }
              // non-ok (403 for this role, 404 for a module that is off) →
              // simply not available offline; never an error.
            } catch (e) { /* connection died mid-warm — the online event retries */ }
          }
        })());
      }
      await Promise.all(workers);
      if (saved && typeof console !== 'undefined') {
        console.info('[pwa] cached ' + saved + ' core data set' + (saved === 1 ? '' : 's') + ' for offline use');
      }
      return saved;
    } catch (e) {
      return 0;
    }
  }

  // ── Logout hygiene: drop cached shell + data and stop the SW ──────────────
  // On shared devices the next user must not see this hotel's offline copies.
  async function wipeCaches() {
    try {
      // Queued offline writes go too (same shared-device rule as the caches):
      // the next shift must not inherit — or sync — the previous hotel's
      // pending work. Staff can see the pending count on the badge before
      // signing out and hit "Sync now" if they want it delivered first.
      if (window.Offline && typeof Offline.wipe === 'function') await Offline.wipe();
    } catch (e) { /* best-effort */ }
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
      }
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('SKIP_WAITING');
      }
    } catch (e) { /* best-effort */ }
  }

  return { promptInstall, canInstall: () => !!deferredPrompt, on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }, online, wipeCaches, warmCache };
})();
