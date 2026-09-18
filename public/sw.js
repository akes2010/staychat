// public/sw.js
// StayChat OS service worker — offline-first for the app shell, network-first
// for API traffic with a short-lived offline fallback.
//
// Strategy summary:
//   • App shell + static assets (pages, css, js, icons): stale-while-revalidate.
//     The dashboard boots instantly, even on hotel Wi-Fi that just died.
//   • /api/GET: network-first with a 4s timeout; falls back to the last cached
//     response so read-only screens still render offline, stamped with an
//     X-Served-From header the client can surface as a stale-data badge.
//   • /api/non-GET: never cached, never queued (writes are refused offline —
//     the UI toasts instead of silently dropping money-moving requests).
//   • Navigations to unknown paths fall back to the SPA shell.
'use strict';

const VERSION = 'v3';
const SHELL_CACHE = 'staychat-shell-' + VERSION;
const ASSET_CACHE = 'staychat-assets-' + VERSION;
const API_CACHE = 'staychat-api-' + VERSION;

const SHELL = [
  '/', '/landing.html', '/index.html', '/app', '/signup.html',
  '/manifest.json', '/favicon.svg', '/icon-192.png', '/icon-512.png',
  '/css/app.css',
];

const ASSETS = [
  '/js/countries.js', '/js/api.js', '/js/ws-client.js', '/js/ui.js', '/js/auth.js',
  '/js/pwa.js', '/js/app.js',
  '/js/pages/dashboard.js', '/js/pages/rooms.js', '/js/pages/bookings.js',
  '/js/pages/booking-engine.js', '/js/pages/wifi.js', '/js/pages/inbox.js',
  '/js/pages/orders.js', '/js/pages/pos.js', '/js/pages/pool.js', '/js/pages/halls.js',
  '/js/pages/misc.js', '/js/pages/housekeeping.js', '/js/pages/maintenance.js',
  '/js/pages/guests.js', '/js/pages/analytics.js', '/js/pages/reports.js',
  '/js/pages/staff.js', '/js/pages/shifts.js', '/js/pages/eod.js', '/js/pages/menu.js',
  '/js/pages/payments.js', '/js/pages/accounting.js', '/js/pages/ai.js',
  '/js/pages/printers.js', '/js/pages/users.js', '/js/pages/settings.js',
  '/js/pages/integrations.js', '/js/pages/billing.js', '/js/pages/superadmin.js',
  '/js/sales.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Cache the shell best-effort; one bad URL must not fail the whole install.
    await Promise.allSettled(SHELL.map(u => shell.add(new Request(u, { cache: 'reload' }))));
    const assets = await caches.open(ASSET_CACHE);
    await Promise.allSettled(ASSETS.map(u => assets.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => ![SHELL_CACHE, ASSET_CACHE, API_CACHE].includes(n)).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

function isStaticAsset(url) {
  return url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') ||
    /\.(png|svg|ico|woff2?|jpg|webp)$/.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // ── API: network-first with timeout, fall back to last good copy ─────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      const cache = await caches.open(API_CACHE);
      try {
        const res = await Promise.race([
          fetch(req),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
        ]);
        if (res && res.ok && req.method === 'GET') cache.put(req, res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match(req);
        if (cached) {
          const stale = new Response(await cached.clone().arrayBuffer(), {
            status: cached.status, headers: cached.headers,
          });
          stale.headers.set('X-Served-From', 'sw-cache');
          return stale;
        }
        return new Response(JSON.stringify({ error: 'You are offline — this data is unavailable right now.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
    })());
    return;
  }

  // ── Navigations: shell first when offline ─────────────────────────────────
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(SHELL_CACHE);
        return (await cache.match(url.pathname))
          || (await cache.match('/index.html'))
          || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // ── Static assets: stale-while-revalidate ─────────────────────────────────
  if (isStaticAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(req);
      const network = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('Offline', { status: 503 });
    })());
  }
});

// Allow the page to ask the SW to stop controlling the tab during logout cache
// wipe, and to broadcast connectivity changes.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
