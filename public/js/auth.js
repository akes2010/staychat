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
    startApp(data.user, data.accessToken, data.tenant);
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
    startApp(data.user, data.accessToken, data.tenant);
    toast('Welcome to StayChat OS! Your hotel account has been created.', 'success');
  } catch (err) {
    console.error('Signup error:', err);
    showAuthError(err.message || 'Could not create your account.');
  } finally {
    btn.disabled = false; btn.textContent = 'Create Account →';
  }
}

function startApp(user, accessToken, tenant) {
  window.App.user = user;
  window.App.tenantId = user.tenantId || null;
  window.App.tenant = tenant || null;
  window.App.accessToken = accessToken;
  window.App.permissions = user.permissions || [];

  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');

  setupSidebar();
  WSClient.setTokenGetter(() => window.App.accessToken);
  WSClient.connect();
  registerRealtimeHandlers();

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
  document.getElementById('app').classList.remove('visible');
  document.getElementById('auth-screen').style.display = '';
  toast('Logged out successfully', 'info');
}

// Attempt silent session restore on page load (refresh-token cookie may still be valid)
async function tryRestoreSession() {
  try {
    // The refresh call itself returns a fresh user+tenant+accessToken, so a
    // separate /me call beforehand is redundant — this also fixes session
    // restore silently failing if /me succeeded but refresh then failed.
    const refreshed = await API.post('/api/auth/refresh', {});
    startApp(refreshed.user, refreshed.accessToken, refreshed.tenant);
  } catch (e) {
    // No valid session — show login screen (already visible by default).
  }
}
