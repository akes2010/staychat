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
    // The operator installs BECAUSE the network is unreliable — download the
    // whole desk onto this device the moment the install lands (a no-op on
    // the landing page, where nobody has signed in yet; sign-in warms too).
    if (window.App && App.user && navigator.onLine) {
      warmCache().then(n => {
        if (n && typeof toast === 'function') {
          toast('📥 Downloaded ' + n + ' desk datasets — this device now works offline', 'success', 5000);
        }
      }).catch(() => {});
    }
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
  // when the Wi-Fi died. After sign-in — whenever the connection comes back —
  // and the moment the operator clicks "Install app" — fetch EVERY read the
  // desk can issue (role permitting) once each and drop them into the SW's
  // API cache under the EXACT url the page will later request (same query
  // string, same order), so the offline copy is hit byte-for-byte.
  //
  // Inventory rule: one entry per COLLECTION read a page in public/js/pages
  // makes. Reads addressed by an id (folio, ticket, conversation thread) are
  // warmed in phase 2 below or on first visit — they need ids we only know
  // after their list has loaded. When a page gains a new list endpoint, add
  // it here or the installed app will hit an offline 503 on first use.
  const CORE_ENDPOINTS = [
    '/api/analytics/summary', '/api/analytics/departments', '/api/analytics/engine',
    '/api/rooms', '/api/room-setup/floors', '/api/room-setup/categories',
    '/api/room-setup/holidays', '/api/room-setup/pools',
    '/api/bookings', '/api/bookings/facilities/pending', '/api/guests', '/api/staff',
    '/api/orders', '/api/menu', '/api/menu/categories', '/api/settings',
    '/api/payments/transactions?limit=2000', '/api/pos/summary', '/api/pos/tickets', '/api/pos/tables',
    '/api/inbox/conversations', '/api/shifts', '/api/shifts/rotation', '/api/maintenance',
    '/api/halls/halls', '/api/halls/bookings', '/api/tables', '/api/printers', '/api/blocklist',
    '/api/misc-services/services', '/api/misc-services/orders', '/api/wifi',
    '/api/reports/types', '/api/booking-engine/admin/config', '/api/help',
    '/api/gym/gyms', '/api/gym/registrations', '/api/fitness/plans', '/api/fitness/memberships',
  ];
  const ADMIN_ENDPOINTS = [
    '/api/users', '/api/users/capabilities', '/api/billing/summary', '/api/billing/usage',
    '/api/billing/pricing', '/api/accounting/accounts', '/api/accounting/journal',
    '/api/accounting/vouchers', '/api/accounting/cashbook', '/api/accounting/credit-sales',
    '/api/accounting/trial-balance', '/api/api-integrations', '/api/api-integrations/available',
    '/api/ai-config', '/api/ai-config/providers', '/api/selfhost/admin/pending-count',
  ];
  const SUPERADMIN_ENDPOINTS = ['/api/superadmin/tenants', '/api/superadmin/overview', '/api/plans/plans',
    '/api/plans/gateways', '/api/superadmin/platform-billing',
    '/api/superadmin/subscriptions?status=pending_approval', '/api/selfhost/admin/orders'];

  // Screens keyed to a calendar date: warm TODAY's url — the date every one
  // of these pages defaults to when it opens (same toISOString() maths), so
  // the hash matches the request the page will actually make.
  function datedEndpoints() {
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    return [
      '/api/pool?date=' + today,
      '/api/eod?date=' + today,
      '/api/eod/overview?date=' + today,
      '/api/eod/mine?date=' + today,
      '/api/shifts/attendance?date=' + today,
      '/api/shifts/rotation/calendar?from=' + today + '&to=' + horizon,
      '/api/messaging/promo/preview?audience=all',
      '/api/reports/transactions?period=daily&date=' + today,
    ];
  }

  function warmPaths() {
    const App_ = typeof window !== 'undefined' ? window.App : null;
    const role = (App_ && App_.user && App_.user.role) || '';
    let paths = CORE_ENDPOINTS.concat(datedEndpoints());
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

  // ── Warm bookkeeping ───────────────────────────────────────────────────
  // One warm at a time: a sign-in and a reconnect racing must not double the
  // download — and the server's per-IP rate-limit budget — for the same data.
  let warming = null;
  // Sign-in/reload path only: a desk that refreshes (or a battery suite that
  // reloads pages) must not re-download the whole dataset every time. The
  // meaningful events — connection restored, app installed — always warm.
  const WARM_ONCE_KEY = 'staychat.warm.completedAt';
  const WARM_ONCE_WINDOW = 5 * 60 * 1000;
  function warmRecentlyCompleted() {
    try {
      const at = Number(sessionStorage.getItem(WARM_ONCE_KEY) || 0);
      return at > 0 && Date.now() - at < WARM_ONCE_WINDOW;
    } catch (e) { return false; }
  }
  function markWarmCompleted() {
    try { sessionStorage.setItem(WARM_ONCE_KEY, String(Date.now())); } catch (e) { /* private mode */ }
  }

  async function warmCache(opts) {
    if (typeof caches === 'undefined') return 0;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return 0;
    // Nobody signed in → every one of these would just be a 401.
    if (!window.App || !App.user) return 0;
    if (opts && opts.once && warmRecentlyCompleted()) return 0;
    if (warming) return warming;
    warming = doWarm();
    try { return await warming; } finally { warming = null; }
  }

  async function doWarm() {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      // Wait for activation: it claims the page and drops superseded caches,
      // so the name we resolve below is the live one.
      try { await navigator.serviceWorker.ready; } catch (e) { /* unsupported */ }
    }
    try {
      const name = await findApiCache();
      if (!name) return 0;
      const cache = await caches.open(name);
      const cacheUrl = (p) => (typeof API !== 'undefined' && API.cacheUrl) ? API.cacheUrl(p) : p;
      const queue = warmPaths();
      let saved = 0;
      const workers = [];
      for (let i = 0; i < 4 && queue.length; i++) {
        workers.push((async () => {
          while (queue.length) {
            if (typeof navigator !== 'undefined' && !navigator.onLine) return;
            const path = queue.shift();
            try {
              const url = cacheUrl(path);
              const res = await fetch(url, { credentials: 'include' });
              if (res.ok) { await cache.put(url, res.clone()); saved++; }
              // non-ok (403 for this role, 404 for a module that is off) →
              // simply not available offline; never an error.
            } catch (e) { /* connection died mid-warm — the online event retries */ }
          }
        })());
      }
      await Promise.all(workers);
      // Phase 2: per-id reads (an inbox thread, an open ticket) can't be
      // listed up front — take the ids back OUT of the phase-1 cache and warm
      // the most recent ones too. A list this role can't see (403) never
      // entered the cache, so its details are skipped for free.
      if (typeof navigator === 'undefined' || navigator.onLine) {
        saved += await warmDetailSets(cache, cacheUrl);
        if (queue.length === 0) markWarmCompleted(); // interrupted warm must not stamp itself done
      }
      if (saved && typeof console !== 'undefined') {
        console.info('[pwa] cached ' + saved + ' desk data sets for offline use');
      }
      return saved;
    } catch (e) {
      return 0;
    }
  }

  // Phase-2 helper for warmCache: detail reads derived from a phase-1 list.
  // Capped so a warm stays a background whisper, not a bandwidth event — the
  // 'online' event re-runs the whole thing whenever the network is healthy.
  // urlOf(item) builds the EXACT url its page will request for that row (an
  // id path, or the query a lookup screen types); keep narrows the list first.
  async function warmDetailSets(cache, cacheUrl) {
    const pull = async (path, limit, urlOf, keep) => {
      let list = [];
      try {
        const hit = await cache.match(cacheUrl(path));
        list = hit ? await hit.json() : [];
      } catch (e) { return 0; }
      if (!Array.isArray(list)) return 0;
      if (keep) list = list.filter(keep);
      let n = 0;
      for (const item of list.slice(0, limit)) {
        const raw = urlOf(item);
        if (!raw) continue;
        try {
          const url = cacheUrl(raw);
          const res = await fetch(url, { credentials: 'include' });
          if (res.ok) { await cache.put(url, res.clone()); n++; }
        } catch (e) { return n; } // connection died — the 'online' event retries
      }
      return n;
    };
    let saved = 0;
    // Front-desk money flows first: settle needs BOTH the room's checkout
    // preview and its pending-charge balance, and a guest's bill is the folio.
    const billable = r => r && r.id && (r.status === 'occupied' || r.status === 'dirty');
    saved += await pull('/api/rooms', 15, r => '/api/rooms/' + encodeURIComponent(r.id) + '/checkout-check', billable);
    saved += await pull('/api/rooms', 15, r => (r.number ? '/api/payments/balance?roomNumber=' + encodeURIComponent(r.number) : null), billable);
    saved += await pull('/api/bookings', 15, b => (b.id ? '/api/bookings/' + encodeURIComponent(b.id) + '/folio' : null));
    saved += await pull('/api/bookings', 15, b => (b.id ? '/api/payments/balance?bookingId=' + encodeURIComponent(b.id) : null));
    saved += await pull('/api/guests', 10, g => (g.id ? '/api/payments/balance?guestId=' + encodeURIComponent(g.id) : null));
    // The EOD close flow asks for MY department's preview for TODAY; the list
    // it derives from (/api/eod/mine) landed in phase 1.
    try {
      const today = new Date().toISOString().slice(0, 10);
      const hit = await cache.match(cacheUrl('/api/eod/mine?date=' + today));
      const mine = hit ? await hit.json() : null;
      if (mine && mine.department) {
        const url = cacheUrl('/api/eod/preview?department=' + mine.department + '&date=' + today);
        const res = await fetch(url, { credentials: 'include' });
        if (res.ok) { await cache.put(url, res.clone()); saved++; }
      }
    } catch (e) { /* connection died — the 'online' event retries */ }
    // The tills and the inbox: an open ticket's detail, the MESSAGES behind
    // the conversation list (the bare conversation url 404s — the page asks
    // for /messages), guest account lookups, each account's ledger, and a
    // transaction's detail (View/Reprint fall back to the list row offline).
    saved += await pull('/api/pos/tickets', 15, t => (t.id ? '/api/pos/tickets/' + encodeURIComponent(t.id) : null));
    saved += await pull('/api/inbox/conversations', 15, c => (c.id ? '/api/inbox/conversations/' + encodeURIComponent(c.id) + '/messages' : null));
    saved += await pull('/api/accounting/accounts', 10, a => (a.id ? '/api/accounting/ledger/' + encodeURIComponent(a.id) : null));
    return saved;
  }

  // ── Logout hygiene: drop cached shell + data and stop the SW ──────────────
  // On shared devices the next user must not see this hotel's offline copies.
  async function wipeCaches() {
    // Next shift re-downloads the dataset for THEIR hotel on sign-in.
    try { sessionStorage.removeItem(WARM_ONCE_KEY); } catch (e) { /* best-effort */ }
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
