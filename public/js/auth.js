// public/js/auth.js
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) => t.classList.toggle('active', ['login', 'signup'][i] === tab));
  document.getElementById('auth-login').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('auth-signup').style.display = tab === 'signup' ? '' : 'none';
  hideAuthError();
}
function togglePass() {
  const p = document.getElementById('auth-pass');
  p.type = p.type === 'password' ? 'text' : 'password';
}
function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = 'flex';
}
function hideAuthError() { document.getElementById('auth-error').style.display = 'none'; }

async function doLogin() {
  hideAuthError();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-pass').value;
  if (!email || !password) { showAuthError('Please enter your email and password.'); return; }

  const btn = document.getElementById('login-submit-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    if (typeof API === 'undefined' || !API.post) {
      throw new Error('API module not loaded. Check browser console for script errors.');
    }
    const data = await API.post('/api/auth/login', { email, password });
    if (!data || !data.user) {
      throw new Error('Invalid response from server');
    }
    startApp(data.user, data.accessToken, data.tenant, data.entitlements);
  } catch (err) {
    console.error('Login error:', err);
    showAuthError(err.message || 'Invalid email or password.');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In →';
  }
}

async function doSignup() {
  hideAuthError();
  const hotelName = document.getElementById('signup-hotel-name').value.trim();
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-pass').value;

  if (!hotelName || !name || !email || !password) { showAuthError('Please fill in all fields.'); return; }
  if (password.length < 8 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    showAuthError('Password must be 8+ characters with uppercase, lowercase, a number, and a special character.');
    return;
  }

  const btn = document.getElementById('signup-submit-btn');
  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    const data = await API.post('/api/auth/register', { hotelName, name, email, password });
    if (!data || !data.user) throw new Error('Invalid response from server');
    startApp(data.user, data.accessToken, data.tenant, data.entitlements);
    toast('Welcome to StayChat OS! Your 30-day trial has started — full features, no card required.', 'success', 6000);
  } catch (err) {
    console.error('Signup error:', err);
    showAuthError(err.message || 'Could not create your account.');
  } finally {
    btn.disabled = false; btn.textContent = 'Create Account →';
  }
}

function startApp(user, accessToken, tenant, entitlements, opts) {
  const offlineRestore = !!(opts && opts.offlineRestore);
  window.App.user = user;
  window.App.tenantId = user.tenantId || null;
  window.App.tenant = tenant || null;
  window.App.accessToken = accessToken;
  window.App.permissions = user.permissions || [];
  window.App.entitlements = entitlements || null;

  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  // Remember who was signed in here so a dead Wi-Fi link can reopen this
  // shell (see tryRestoreSession) instead of demanding the password again.
  // Deliberately NOT the access token: it lives 15 minutes anyway, and the
  // httpOnly refresh cookie is what actually gets the session back.
  if (!offlineRestore) saveSessionSnapshot(user, tenant, entitlements);
  if (offlineRestore) {
    toast('📴 You are offline — reopening your last session from this device. Your data is here; anything you change will sync when the connection returns.', 'warn', 9000);
  }

  setupSidebar();
  WSClient.setTokenGetter(() => window.App.accessToken);
  WSClient.reconnectWithNewTenant(); // fresh connection with the current token (no-op if already up)
  registerRealtimeHandlers();
  // The server's persisted skin theme arrives with /me — apply it now (bootTheme
  // already painted the localStorage guess before the shell rendered).
  if (typeof applyTheme === 'function' && user.theme) applyTheme(user.theme);
  if (typeof showTrialBanner === 'function') showTrialBanner();
  showInstallButtonIfAvailable();
  // Pull the desk's data onto this device in the background so the installed
  // PWA can still render rooms, bookings, guests… during a network outage —
  // not only the handful of pages this user happened to open while online.
  // { once: true }: a page refresh inside the window skips the re-download
  // (the data is already here) — the 'online' and appinstalled triggers in
  // pwa.js still run unconditionally.
  if (window.PWA && !offlineRestore && typeof navigator !== 'undefined' && navigator.onLine) {
    setTimeout(() => { try { PWA.warmCache({ once: true }); } catch (e) { /* non-fatal */ } }, 1500);
  }

  const landingPage = user.role === 'superadmin' && !App.tenantId ? 'superadmin'
    : (user.role === 'cashier' || user.role === 'barman' || user.role === 'waiter' || user.role === 'server') ? 'pos'
    : 'dashboard';
  navigate(landingPage);
  if (!offlineRestore) toast('Welcome back, ' + user.name + '!', 'success');
}

async function doLogout() {
  try { await API.post('/api/auth/logout', {}); } catch (e) { /* ignore */ }
  clearSessionSnapshot();
  window.App.user = null;
  window.App.tenantId = null;
  window.App.tenant = null;
  window.App.permissions = [];
  window.App.accessToken = null;
  window.App.entitlements = null;
  document.getElementById('app').classList.remove('visible');
  document.getElementById('auth-screen').style.display = '';
  // Close the live socket and stop its reconnect loop — otherwise it keeps
  // retrying with the now-cleared token after logout.
  if (typeof WSClient !== 'undefined') WSClient.disconnect();
  // Shared-device hygiene: drop every cached shell/API copy so the next shift
  // starts clean. The service worker re-registers fresh on next load.
  if (window.PWA) await PWA.wipeCaches();
  if (navigator.serviceWorker) {
    try { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); } catch (e) {}
  }
  toast('Logged out successfully', 'info');
}
// Expose logout for the account dropdown (openUserMenu in app.js guards on
// window.__doLogout). Without this assignment the menu's "Sign out" button
// silently did nothing — the 🚪 topbar button worked, but the menu looked
// like the primary way out and left users stranded.
window.__doLogout = doLogout;

// Surface the install button once the browser says the app is installable.
function showInstallButtonIfAvailable() {
  const btn = document.getElementById('install-btn');
  if (!btn || !window.PWA) return;
  const show = () => { btn.style.display = ''; };
  if (PWA.canInstall()) show(); else PWA.on('installable', show);
}

// Attempt silent session restore on page load (refresh-token cookie may still be valid)
//
// Exactly ONE refresh runs per page at a time: the refresh token is single-
// use server-side and presenting it twice concurrently revokes EVERY session
// for the user (rotation guard in server/routes/auth.js). Boot restore
// (app.js),401-retry loops and explicit calls can all ask for a restore at
// once — they share the in-flight request instead of racing it; a later call
// (a retry loop) starts fresh once it settles.
let __restoreInflight = null;
async function tryRestoreSession() {
  if (__restoreInflight) return __restoreInflight;
  __restoreInflight = (async () => {
    // ONE refresh for the whole page (shared with the 401 retry in api.js,
    // the WS 4001 handler and the offline outbox) — presenting the single-use
    // refresh cookie twice is what used to revoke every session.
    const r = await API.refreshSession();
    if (r.status === 'ok') {
      startApp(r.data.user, r.data.accessToken, r.data.tenant, r.data.entitlements);
      return;
    }
    if (r.status === 'unauthorized') {
      // The server has ruled the cookie dead — a genuine sign-out.
      clearSessionSnapshot();
      return; // login screen is already visible by default
    }
    // 'unavailable': the server could not be reached at all (offline desk,
    // Wi-Fi flap, deploy in progress). The refresh cookie is very likely
    // still perfectly good, so do NOT fall back to the sign-in form — that is
    // what made staff retype their password every time the network blinked,
    // and impossible to satisfy while actually offline. Reopen the shell from
    // the session this device saved last time; armOfflineSessionRecovery()
    // re-validates it the moment connectivity returns.
    const snap = readSessionSnapshot();
    if (snap) startApp(snap.user, null, snap.tenant, snap.entitlements, { offlineRestore: true });
  })();
  try {
    return await __restoreInflight;
  } finally {
    __restoreInflight = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OFFLINE SESSION SNAPSHOT
// A minimal record of "who was signed in on this device" kept in
// localStorage. It holds NO credentials — no password, no access token, no
// refresh token (the refresh cookie is httpOnly and never leaves the server).
// It exists purely so the PWA can boot its cached shell and cached data when
// the network is gone; the very first authenticated call after connectivity
// returns re-validates the real session and overwrites it.
// ═══════════════════════════════════════════════════════════════════════════
const SESSION_SNAPSHOT_KEY = 'staychat.session-snapshot.v1';
const SESSION_SNAPSHOT_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // matches refresh-cookie life

function saveSessionSnapshot(user, tenant, entitlements) {
  try {
    if (!user) return;
    localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify({
      user, tenant: tenant || null, entitlements: entitlements || null, savedAt: Date.now(),
    }));
  } catch (e) { /* private mode / quota — offline boot simply falls back to login */ }
}

function readSessionSnapshot() {
  try {
    const raw = localStorage.getItem(SESSION_SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.user || !snap.user.id) { clearSessionSnapshot(); return null; }
    if (Date.now() - (snap.savedAt || 0) > SESSION_SNAPSHOT_MAX_AGE) { clearSessionSnapshot(); return null; }
    return snap;
  } catch (e) {
    clearSessionSnapshot();
    return null;
  }
}

function clearSessionSnapshot() {
  try { localStorage.removeItem(SESSION_SNAPSHOT_KEY); } catch (e) { /* non-fatal */ }
}

// Re-validate a snapshot-booted session as soon as the network is back.
// Reads served from the service-worker cache never produce a 401, so without
// this the shell could sit there with a null access token (no live socket, no
// writes) until the member of staff happened to trigger an uncached call.
function armOfflineSessionRecovery() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', async () => {
    if (!window.App || !App.user || App.accessToken) return; // nothing to repair
    const r = await API.refreshSession();
    if (r.status === 'ok') {
      if (typeof WSClient !== 'undefined') WSClient.reconnectWithNewTenant();
      if (typeof navigate === 'function' && App.page) navigate(App.page);
      toast('Back online — your session is live again.', 'success', 4000);
    } else if (r.status === 'unauthorized') {
      clearSessionSnapshot();
      API.handoffToLogin();
    }
  });
}
armOfflineSessionRecovery();
