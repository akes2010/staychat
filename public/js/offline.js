// public/js/offline.js
// Offline-first write queue ("outbox") + sync engine.
//
// The service worker keeps the app SHELL and read data alive offline; this
// module keeps WRITES alive. Whitelisted operations (api.js calls passing
// { offline: true } — new reservation, guest registration, check-in,
// check-out, settle) are stored in IndexedDB when the network is gone and
// replayed, strictly in order, when it returns. Every queued request carries
// an Idempotency-Key the server executes exactly ONCE (see
// server/middleware/idempotency.js) — so a replay after a half-open
// connection can never double-book a room or double-charge a guest.
//
// Outbox states:
//   pending   → waiting for connection; auto-retried (online event, every
//               30s, tab-visible, SW background-sync, manual "Sync now")
//   conflict  → the server REJECTED it (4xx, e.g. the room was sold to
//               someone else while this device was offline) → FLAGGED FOR
//               STAFF REVIEW in red; never auto-retried — a human decides
//   error     → server 5xx; retried with backoff
//
// Logout wipes the outbox together with the caches (shared front-desk
// devices must not leak one shift's queued data to the next) — sync
// everything (badge shows the pending count) before signing out.
'use strict';

window.Offline = (() => {
  const DB_NAME = 'staychat-offline';
  const STORE = 'outbox';
  const RETRY_MS = 30 * 1000;      // periodic sync attempt while online
  const ERROR_BACKOFF_MAX = 5 * 60 * 1000;
  let dbp = null;
  let flushing = false;
  let retryTimer = null;
  let errorStreak = 0;

  // ── ids ─────────────────────────────────────────────────────────────────
  function uid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* insecure ctx */ }
    return 'o-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  // ── IndexedDB ───────────────────────────────────────────────────────────
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const st = d.createObjectStore(STORE, { keyPath: 'id' });
          st.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; }); // allow retry after a transient failure
    return dbp;
  }

  function run(mode, fn) {
    return open().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  const allItems = () => run('readonly', st => st.getAll()).then(list => (list || []).sort((a, b) => a.createdAt - b.createdAt));
  const putItem = (item) => run('readwrite', st => st.put(item));
  const delItem = (id) => run('readwrite', st => st.delete(id));

  // ── counts / badge ──────────────────────────────────────────────────────
  async function counts() {
    try {
      const items = await allItems();
      return {
        pending: items.filter(i => i.status === 'pending').length,
        conflict: items.filter(i => i.status === 'conflict').length,
        error: items.filter(i => i.status === 'error').length,
        items,
      };
    } catch (e) {
      return { pending: 0, conflict: 0, error: 0, items: [] };
    }
  }

  function ensureBadge() {
    let el = document.getElementById('offline-queue-badge');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'offline-queue-badge';
    el.style.cssText = 'display:none;position:fixed;left:16px;bottom:16px;z-index:960;' +
      'padding:9px 14px;border-radius:999px;font-size:12.5px;font-weight:700;cursor:pointer;' +
      'font-family:inherit;letter-spacing:.2px;box-shadow:0 6px 22px rgba(0,0,0,.35);' +
      'border:1px solid rgba(255,255,255,.12);user-select:none;max-width:60vw;';
    el.setAttribute('role', 'status');
    el.onclick = () => openLedger();
    document.body.appendChild(el);
    return el;
  }

  async function render() {
    if (typeof document === 'undefined') return;
    const el = ensureBadge();
    const c = await counts();
    if (c.pending + c.error + c.conflict === 0) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    if (c.conflict > 0) {
      el.style.background = 'var(--error, #c0392b)';
      el.style.color = '#fff';
      el.textContent = '⚠ ' + c.conflict + ' need' + (c.conflict === 1 ? 's' : '') + ' staff review — tap';
      el.title = 'Offline change' + (c.conflict === 1 ? '' : 's') + ' rejected by the server. Open to review.';
    } else {
      el.style.background = 'var(--warn, #b7791f)';
      el.style.color = '#141414';
      el.textContent = '⏳ ' + c.pending + ' change' + (c.pending === 1 ? '' : 's') + ' waiting to sync — tap';
      el.title = 'Saved on this device while offline. They upload automatically when the connection returns.';
    }
  }

  // ── enqueue ─────────────────────────────────────────────────────────────
  async function enqueue(op) {
    const item = {
      id: uid(),
      key: op.key || uid(),
      method: op.method,
      path: op.path,
      body: op.body,
      label: op.label || (op.method + ' ' + op.path),
      status: 'pending',
      attempts: 0,
      lastStatus: null,
      lastError: null,
      createdAt: Date.now(),
    };
    await putItem(item);
    render();
    if (typeof toast === 'function') {
      toast('📴 Offline — saved on this device. It will sync automatically when the connection returns.', 'warn', 5000);
    }
    return item;
  }

  const newKey = () => uid();

  // ── transport: one attempt of one queued request ────────────────────────
  async function sendOnce(item) {
    const doFetch = () => fetch(item.path, {
      method: item.method,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.key },
      credentials: 'include',
      body: item.body !== undefined && item.body !== null ? JSON.stringify(item.body) : undefined,
    });

    let res;
    try { res = await doFetch(); }
    catch (e) { return { kind: 'network' }; }

    if (res.status === 401) {
      // Session may have expired while the device was offline — refresh once,
      // then retry the item once. Still 401 → the user must sign in again;
      // the queue survives (IndexedDB) and resumes after login.
      const ok = await tryRefresh();
      if (ok) {
        try { res = await doFetch(); } catch (e) { return { kind: 'network' }; }
      }
      if (res.status === 401) return { kind: 'unauthorized' };
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }

    if (res.ok) return { kind: 'synced', data };
    const code = data && data.code;
    if (code === 'IN_FLIGHT') return { kind: 'inflight' };
    if (res.status >= 500) return { kind: 'server-error', error: (data && data.error) || ('HTTP ' + res.status) };
    // 4xx: the server evaluated it and said no — conflict for a human.
    return { kind: 'conflict', status: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
  }

  async function tryRefresh() {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
      if (!res.ok) return false;
      const data = await res.json().catch(() => null);
      if (data && window.App) {
        if (data.accessToken) App.accessToken = data.accessToken;
        if (data.user) App.user = data.user;
        if (data.tenant) App.tenant = data.tenant;
        if (data.entitlements) App.entitlements = data.entitlements;
      }
      return !!(data && data.accessToken);
    } catch (e) { return false; }
  }

  // ── local-id → server-id rewrite ───────────────────────────────────
  // A queued operation can DEPEND on another queued operation's server id:
  // the walk-in flow queues "create guest" first, then "check-in with that
  // guest". The dependent body stores the guest op's LOCAL id (its outbox
  // id) as a placeholder. Once the guest op syncs and we know the real
  // server id, rewrite the placeholder in every still-pending body — strict
  // FIFO order guarantees the guest exists before the check-in replays.
  async function applyPlaceholders(item, data) {
    const realId = data && typeof data === 'object' && !Array.isArray(data) ? (data.id || null) : null;
    if (!realId || !item.id) return;
    try {
      const items = await allItems();
      for (const other of items) {
        if (other.id === item.id || other.status !== 'pending') continue;
        if (other.body === undefined || other.body === null) continue;
        const raw = typeof other.body === 'string' ? other.body : JSON.stringify(other.body);
        if (raw.indexOf(item.id) === -1) continue;
        other.body = JSON.parse(raw.split(item.id).join(realId));
        await putItem(other);
      }
    } catch (e) { /* non-fatal — the dependent op will surface as a flagged conflict */ }
  }

  // ── flush: replay pending items strictly in order ───────────────────────
  async function flush() {
    if (flushing || !navigator.onLine) return 0;
    flushing = true;
    let synced = 0;
    let stopReason = null;
    try {
      const items = (await allItems()).filter(i => i.status === 'pending');
      for (const item of items) {
        if (!navigator.onLine) { stopReason = 'offline'; break; }
        const r = await sendOnce(item);
        if (r.kind === 'synced') {
          await applyPlaceholders(item, r.data);
          await delItem(item.id);
          synced++;
        } else if (r.kind === 'conflict') {
          // Server said no → FLAG FOR STAFF (never auto-retry: the answer
          // will not change without a human decision).
          item.status = 'conflict';
          item.lastStatus = r.status;
          item.lastError = r.error;
          item.attempts = (item.attempts || 0) + 1;
          await putItem(item);
        } else if (r.kind === 'inflight') {
          stopReason = 'inflight'; // same key still executing server-side
          break;
        } else if (r.kind === 'unauthorized') {
          stopReason = 'auth';
          if (typeof toast === 'function') {
            toast('Your session expired — sign in again to sync your offline changes (they are safe on this device).', 'warn', 8000);
          }
          break;
        } else if (r.kind === 'server-error') {
          item.status = 'error';
          item.attempts = (item.attempts || 0) + 1;
          item.lastError = r.error;
          await putItem(item);
          stopReason = 'server'; // don't hammer a struggling server
          break;
        } else { // network
          stopReason = 'network';
          break;
        }
      }
    } catch (e) {
      stopReason = 'store:' + (e && e.message);
    } finally {
      flushing = false;
    }

    errorStreak = (stopReason === 'server' || stopReason === 'network') ? errorStreak + 1 : 0;
    await render();

    if (synced > 0) {
      if (typeof toast === 'function') {
        toast('✅ Synced ' + synced + ' offline change' + (synced === 1 ? '' : 's') + ' — everything is live.', 'success', 5000);
      }
      try { window.dispatchEvent(new CustomEvent('staychat:synced', { detail: { count: synced } })); } catch (e) { /* IE-safe */ }
      refreshCurrentPage();
      // A conflict may have surfaced during this same pass.
      const c = await counts();
      if (c.conflict > 0 && typeof toast === 'function') {
        toast('⚠ ' + c.conflict + ' offline change' + (c.conflict === 1 ? '' : 's') + ' could not be applied — tap the badge to review.', 'error', 9000);
      }
    }
    scheduleRetry();
    return synced;
  }

  function refreshCurrentPage() {
    // The synced records now exist server-side; re-run the current page's
    // load() the same way navigation does — unless a modal is open (do not
    // yank a receipt or a half-typed form out from under the staff).
    try {
      const mc = document.getElementById('modal-container');
      if (mc && mc.innerHTML.trim() !== '') return;
      if (window.App && App.page && typeof window.navigate === 'function') window.navigate(App.page);
    } catch (e) { /* non-fatal */ }
  }

  function scheduleRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    const backoff = Math.min(ERROR_BACKOFF_MAX, RETRY_MS * Math.pow(2, Math.max(0, errorStreak - 1)));
    retryTimer = setTimeout(() => { retryTimer = null; flush(); }, backoff);
  }

  // ── ledger modal ────────────────────────────────────────────────────────
  async function openLedger() {
    const c = await counts();
    if (c.items.length === 0) { render(); return; }
    const when = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const statusChip = (it) => {
      if (it.status === 'conflict') return '<span style="color:var(--error);font-weight:700">⚠ needs review</span>';
      if (it.status === 'error') return '<span style="color:var(--warn);font-weight:700">retrying…</span>';
      return '<span style="color:var(--a);font-weight:700">queued</span>';
    };
    const rows = c.items.map(it =>
      '<div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-bottom:1px solid var(--line,#2a2a2a)">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:650;font-size:13px">' + escapeHtml(it.label) + '</div>' +
          '<div style="font-size:11.5px;color:var(--text3);margin-top:2px">' + it.method + ' ' + escapeHtml(it.path) + ' · saved ' + when(it.createdAt) + '</div>' +
          (it.lastError ? '<div style="font-size:11.5px;color:var(--error);margin-top:3px">' + escapeHtml(it.lastError) + '</div>' : '') +
        '</div>' +
        '<div style="text-align:right;white-space:nowrap">' + statusChip(it) +
          (it.status === 'conflict'
            ? '<div style="margin-top:6px"><button class="btn outline" style="padding:3px 9px;font-size:11px" onclick="window.__offRetry(this.dataset.id)" data-id="' + it.id + '">Retry</button> ' +
              '<button class="btn outline" style="padding:3px 9px;font-size:11px" onclick="window.__offDismiss(this.dataset.id)" data-id="' + it.id + '">Dismiss</button></div>'
            : '') +
        '</div>' +
      '</div>').join('');

    openModal('Offline changes — ' + c.pending + ' waiting · ' + c.conflict + ' need review',
      '<div style="font-size:12.5px;color:var(--text3);margin-bottom:12px">' +
        'Work done without a connection is stored safely on this device and uploads automatically in order. ' +
        'Items marked <b>needs review</b> were rejected by the server (e.g. the room was booked by someone else meanwhile) — a person must decide what to do.' +
      '</div>' +
      '<div style="max-height:50vh;overflow:auto;border:1px solid var(--line,#2a2a2a);border-radius:var(--radius)">' + rows + '</div>',
      '<button class="btn outline" onclick="closeModal()">Close</button>' +
      '<button class="btn outline" onclick="window.__offWipe()">Discard all</button>' +
      '<button class="btn primary" onclick="window.__offSyncNow()">Sync now</button>'
    );
  }

  window.__offSyncNow = async () => {
    closeModal();
    if (!navigator.onLine) { if (typeof toast === 'function') toast('Still offline — changes stay queued and sync the moment the connection returns.', 'warn'); return; }
    await flush();
  };
  window.__offRetry = async (id) => {
    try {
      const d = await open();
      const it = await new Promise((res, rej) => {
        const r = d.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      if (it) { it.status = 'pending'; it.lastError = null; await putItem(it); }
    } catch (e) { /* fall through to render */ }
    render();
    openLedger();
    flush();
  };
  window.__offDismiss = async (id) => {
    await delItem(id);
    render();
    openLedger();
  };
  window.__offWipe = async () => {
    if (typeof confirmAction === 'function') {
      confirmAction('Discard ALL queued offline changes? Anything not yet synced will be permanently lost.', async () => { await wipe(); closeModal(); });
    } else { await wipe(); closeModal(); }
  };

  async function wipe() {
    try {
      const items = await allItems();
      await Promise.all(items.map(i => delItem(i.id)));
    } catch (e) { /* best-effort */ }
    render();
  }

  // ── init ────────────────────────────────────────────────────────────────
  function init() {
    if (initDone()) return;
    window.__offInit = true;
    ensureBadge();
    render();

    // Connection came back → sync fast (the 2–5 hour outage just ended).
    window.addEventListener('online', () => { errorStreak = 0; setTimeout(() => flush(), 400); });
    window.addEventListener('offline', () => render());

    // Periodic safety net while there is anything pending.
    setInterval(() => {
      if (navigator.onLine) flush();
    }, RETRY_MS);

    // Tab came to the foreground with queued work.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) flush(); });

    // Service-worker Background Sync (Chrome/Android: fires even from the
    // SW when the connection flaps) → SW messages every client to flush.
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data === 'SYNC_NOW') flush();
        });
        navigator.serviceWorker.ready.then(reg => {
          // sync.register() rejects in environments that disable Background
          // Sync (Electron desktop app, some privacy modes) — catch the
          // INNER promise too, otherwise it surfaces as an unhandled
          // rejection on every boot. The online-event flush covers us there.
          if (reg.sync && typeof reg.sync.register === 'function') {
            Promise.resolve(reg.sync.register('staychat-sync')).catch(() => {});
          }
        }).catch(() => { /* not supported (Safari/Firefox) — online event covers us */ });
      }
    } catch (e) { /* non-fatal */ }

    // Live channel re-established (WS reconnect = network is back).
    try { if (typeof WSClient !== 'undefined') WSClient.on('connected', () => flush()); } catch (e) { /* non-fatal */ }

    // App just booted online with items left from an earlier session.
    if (navigator.onLine) setTimeout(() => flush(), 1500);

    // The SW asks for a sync registration whenever a write is queued.
    window.addEventListener('staychat:offline-enqueued', () => {
      try {
        navigator.serviceWorker.ready.then(reg => {
          if (reg.sync && typeof reg.sync.register === 'function') {
            Promise.resolve(reg.sync.register('staychat-sync')).catch(() => {});
          }
        }).catch(() => {});
      } catch (e) { /* non-fatal */ }
    });
  }

  let _inited = false;
  function initDone() { if (_inited) return true; _inited = true; return false; }

  return {
    init, enqueue, flush, wipe, counts, render, newKey,
    openLedger,
    online: () => navigator.onLine,
  };
})();

// Boot once the DOM is up (badge needs document.body).
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.Offline.init());
} else {
  window.Offline.init();
}
