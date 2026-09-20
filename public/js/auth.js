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
    toast('Welcome to StayChat OS! Your 14-day trial has started — full features, no card required.', 'success', 6000);
  } catch (err) {
    console.error('Signup error:', err);
    showAuthError(err.message || 'Could not create your account.');
  } finally {
    btn.disabled = false; btn.textContent = 'Create Account →';
  }
}

function startApp(user, accessToken, tenant, entitlements) {
  window.App.user = user;
  window.App.tenantId = user.tenantId || null;
  window.App.tenant = tenant || null;
  window.App.accessToken = accessToken;
  window.App.permissions = user.permissions || [];
  window.App.entitlements = entitlements || null;

  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  setupSidebar();
  WSClient.setTokenGetter(() => window.App.accessToken);
  WSClient.reconnectWithNewTenant(); // fresh connection with the current token (no-op if already up)
  registerRealtimeHandlers();
  if (typeof showTrialBanner === 'function') showTrialBanner();
  showInstallButtonIfAvailable();

  const landingPage = user.role === 'superadmin' && !App.tenantId ? 'superadmin'
    : (user.role === 'cashier' || user.role === 'barman') ? 'pos'
    : 'dashboard';
  navigate(landingPage);
  toast('Welcome back, ' + user.name + '!', 'success');
}

async function doLogout() {
  try { await API.post('/api/auth/logout', {}); } catch (e) { /* ignore */ }
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

// Surface the install button once the browser says the app is installable.
function showInstallButtonIfAvailable() {
  const btn = document.getElementById('install-btn');
  if (!btn || !window.PWA) return;
  const show = () => { btn.style.display = ''; };
  if (PWA.canInstall()) show(); else PWA.on('installable', show);
}

// Attempt silent session restore on page load (refresh-token cookie may still be valid)
async function tryRestoreSession() {
  try {
    // The refresh call itself returns a fresh user+tenant+accessToken, so a
    // separate /me call beforehand is redundant — this also fixes session
    // restore silently failing if /me succeeded but refresh then failed.
    const refreshed = await API.post('/api/auth/refresh', {});
    startApp(refreshed.user, refreshed.accessToken, refreshed.tenant, refreshed.entitlements);
  } catch (e) {
    // No valid session — show login screen (already visible by default).
  }
}
