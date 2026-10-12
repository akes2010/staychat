// public/js/theme.js — Skin themes: the signed-in user picks the colour skin
// they want to work in. One canonical THEMES list (server mirrors it in
// server/routes/auth.js — keep both in sync). Applies instantly by setting
// [data-theme] on <body>, persists to the user's account, remembers the
// choice in localStorage so the chosen skin paints BEFORE the app shell
// renders on the next visit (no flash of default green).
'use strict';

const THEMES = [
  { id: 'green',    name: 'WhatsApp Green', swatch: '#006d2f', accent: '#25d366' },
  { id: 'emerald',  name: 'Emerald',        swatch: '#046d4c', accent: '#10b981' },
  { id: 'ocean',    name: 'Ocean Blue',     swatch: '#0c4a8a', accent: '#38bdf8' },
  { id: 'royal',    name: 'Royal Purple',   swatch: '#4527a0', accent: '#a78bfa' },
  { id: 'crimson',  name: 'Crimson',        swatch: '#9f1239', accent: '#fb7185' },
  { id: 'amber',    name: 'Amber Gold',     swatch: '#92400e', accent: '#fbbf24' },
  { id: 'slate',    name: 'Slate Pro',      swatch: '#1e293b', accent: '#22d3ee' },
  { id: 'rose',     name: 'Rose',           swatch: '#9d174d', accent: '#f472b6' },
];

// ── Boot-time application (runs before the shell paints) ────────────────
// Priority: server's saved theme (App.user.theme, set by /api/auth/me)
// → localStorage → default green.
function applyTheme(themeId) {
  const t = THEMES.find(x => x.id === themeId) ? themeId : 'green';
  document.body.setAttribute('data-theme', t === 'green' ? 'green' : t);
  // green is :root default, but setting the attribute keeps intent explicit.
  try { localStorage.setItem('staychat-theme', t); } catch (e) { /* private mode */ }
  return t;
}
function bootTheme() {
  // Cached paint FIRST — synchronous, before app.js renders the shell.
  let cached = 'green';
  try { cached = localStorage.getItem('staychat-theme') || 'green'; } catch (e) {}
  applyTheme(cached);
  // Then let the server's persisted value win if it differs (another device).
  if (window.App && App.user && App.user.theme && App.user.theme !== cached) {
    applyTheme(App.user.theme);
  }
}
bootTheme();

// ── Picker ───────────────────────────────────────────────────────────────
// Opens a modal of skin swatches. Selecting one applies instantly, then
// PATCHes the account so it follows the user to every device.
window.__openThemePicker = function () {
  const current = (window.App && App.user && App.user.theme) || (() => { try { return localStorage.getItem('staychat-theme'); } catch (e) { return null; } })() || 'green';
  const body = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:12px">' +
    THEMES.map(t =>
      '<button class="theme-card" data-theme-id="' + t.id + '" style="border:2px solid ' + (t.id === current ? 'var(--p)' : 'var(--border)') + ';border-radius:14px;padding:14px 10px;background:var(--surface2);cursor:pointer;text-align:center">' +
        '<span style="display:inline-flex;gap:4px;margin-bottom:8px">' +
          '<span style="width:26px;height:26px;border-radius:50%;background:' + t.swatch + ';box-shadow:0 2px 6px rgba(0,0,0,.25)"></span>' +
          '<span style="width:26px;height:26px;border-radius:50%;background:' + t.accent + ';box-shadow:0 2px 6px rgba(0,0,0,.25)"></span>' +
        '</span>' +
        '<div style="font-size:12.5px;font-weight:700;color:var(--text)">' + t.name + '</div>' +
        (t.id === current ? '<div style="font-size:10.5px;color:var(--p-light);font-weight:700;margin-top:3px">● Active</div>' : '') +
      '</button>').join('') +
  '</div>' +
  '<p style="font-size:12px;color:var(--text3);margin-top:14px">Applies instantly and saves to your account — same skin on every device. Colours restyle the whole workspace: sidebar, buttons, badges, charts and receipts.</p>';

  openModal('🎨 Choose your theme', body,
    '<button class="btn outline" onclick="closeModal()">Close</button>');

  document.querySelectorAll('.theme-card').forEach(card => {
    card.onclick = async () => {
      const id = card.getAttribute('data-theme-id');
      applyTheme(id);
      try {
        await API.patch('/api/auth/theme', { theme: id });
        if (window.App && App.user) App.user.theme = id;
        toast('Theme set to ' + (THEMES.find(t => t.id === id) || {}).name, 'success');
      } catch (err) {
        toast('Theme applied on this device, but saving to your account failed: ' + err.message, 'warn');
      }
      closeModal();
      document.querySelectorAll('.theme-card').forEach(c => {});
    };
  });
};

// Hook the user-menu (top-right 👤) once app.js has rendered the shell.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.theme-link') && e.target.closest('.icon-btn') === null) return;
}, true);
