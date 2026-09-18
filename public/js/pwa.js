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
  window.addEventListener('online', () => { emit('offline', false); if (typeof toast === 'function') toast('Back online — syncing live data', 'success'); });
  window.addEventListener('offline', () => { emit('offline', true); if (typeof toast === 'function') toast('You are offline — showing last known data', 'error', 4000); });

  // ── Logout hygiene: drop cached shell + data and stop the SW ──────────────
  // On shared devices the next user must not see this hotel's offline copies.
  async function wipeCaches() {
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

  return { promptInstall, canInstall: () => !!deferredPrompt, on: (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); }, online, wipeCaches };
})();
