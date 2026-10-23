// public/js/pages/integrations.js
// API Integrations — configure external service credentials (payment gateways,
// OTA channels, SMS/email providers, storage, analytics). Credentials are
// entered here; features consume them via the server-side api-resolver.
window.PAGES = window.PAGES || {};

PAGES.integrations = function () {
  const wrap = el('div', 'fa');
  const state = { configured: [], available: [], categories: [], filter: 'all' };

  const CATEGORY_META = {
    payment_gateway: { label: 'Payment Gateways', ico: '💳' },
    ota_channel: { label: 'OTA / Booking Channels', ico: '🌐' },
    sms_provider: { label: 'SMS Providers', ico: '📱' },
    email_provider: { label: 'Email Providers', ico: '✉️' },
    notification: { label: 'Push Notifications', ico: '🔔' },
    storage: { label: 'Cloud Storage', ico: '☁️' },
    analytics: { label: 'Analytics', ico: '📊' },
    door_lock: { label: 'Door Locks', ico: '🚪' },
    iptv_vod: { label: 'IPTV & VOD', ico: '📺' },
    internet_management: { label: 'Internet Management', ico: '📶' },
    room_automation: { label: 'Room Automation', ico: '🏠' },
    iot_platform: { label: 'Zigbee / IoT & Cameras', ico: '📡' },
  };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading integrations…');
    try {
      const [configured, available] = await Promise.all([
        API.get('/api/api-integrations'),
        API.get('/api/api-integrations/available'),
      ]);
      state.configured = configured;
      state.available = available.services;
      state.categories = available.categories;
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'integrations\')');
    }
  }

  function configFor(serviceKey) {
    return state.configured.find(c => c.service_key === serviceKey);
  }

  function render() {
    const cats = state.filter === 'all' ? state.categories : [state.filter];
    wrap.innerHTML = '' +
      '<div class="page-header"><div class="page-header-left"><h1>API Integrations</h1>' +
        '<p>Connect payment gateways, booking channels, and messaging providers. Add your API keys when you have them.</p></div></div>' +
      '<div class="alert info" style="font-size:12px;margin-bottom:16px">🔒 Secret keys are stored encrypted-at-rest and never shown in full after saving. You can update them any time.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px">' +
        filterChip('all', 'All') +
        state.categories.map(c => filterChip(c, (CATEGORY_META[c] || {}).ico + ' ' + ((CATEGORY_META[c] || {}).label || c))).join('') +
      '</div>' +
      cats.map(renderCategory).join('');

    bindEvents();
  }

  // Local helper — renderServiceCard referenced fmtDate but it was never
  // defined, so any configured service crashed the page with
  // "Something went wrong: fmtDate is not defined". Tolerates both plain
  // dates ('YYYY-MM-DD') and full timestamps from last_verified_at.
  function fmtDate(d) {
    const s = String(d || '');
    const dt = new Date(s.length === 10 ? s + 'T00:00:00' : s);
    if (isNaN(dt.getTime())) return s;
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function filterChip(value, label) {
    const active = state.filter === value;
    return '<button class="chip' + (active ? ' active' : '') + '" data-filter="' + escapeHtml(value) + '" ' +
      'style="padding:6px 14px;border-radius:20px;border:1.5px solid ' + (active ? 'var(--p)' : 'var(--border)') + ';' +
      'background:' + (active ? 'var(--p)' : 'var(--surface)') + ';color:' + (active ? '#fff' : 'var(--text)') + ';cursor:pointer;font-size:13px;font-weight:600">' +
      escapeHtml(label) + '</button>';
  }

  function renderCategory(category) {
    const meta = CATEGORY_META[category] || { label: category, ico: '🔌' };
    const services = state.available.filter(s => s.category === category);
    if (!services.length) return '';

    return '<div style="margin-bottom:28px">' +
      '<div style="font-size:13px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.03em;margin-bottom:12px">' +
        meta.ico + ' ' + escapeHtml(meta.label) + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px">' +
        services.map(renderServiceCard).join('') +
      '</div></div>';
  }

  function renderServiceCard(service) {
    const config = configFor(service.key);
    const isActive = config && config.active;
    const statusBadge = !config
      ? badge('Not configured', 'default')
      : (isActive ? badge('Active', 'success') : badge('Configured (off)', 'warning'));

    let health = '';
    if (config && config.last_error) {
      health = '<div style="font-size:11px;color:var(--error);margin-top:6px">⚠ ' + escapeHtml(config.last_error) + '</div>';
    } else if (config && config.last_verified_at) {
      health = '<div style="font-size:11px;color:var(--success);margin-top:6px">✓ Verified ' + fmtDate(config.last_verified_at) + '</div>';
    }

    return '<div class="card" style="padding:16px;cursor:pointer" data-service="' + escapeHtml(service.key) + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">' +
        '<div style="font-weight:700;font-size:15px">' + escapeHtml(service.name) + '</div>' + statusBadge +
      '</div>' +
      (config && config.test_mode ? '<div style="font-size:11px;color:var(--warning);font-weight:600;margin-bottom:4px">TEST MODE</div>' : '') +
      '<div style="font-size:12px;color:var(--text3)">' + service.credentials.length + ' credential' + (service.credentials.length === 1 ? '' : 's') +
        (service.docs ? ' · <a href="' + escapeHtml(service.docs) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--p)">Docs ↗</a>' : '') + '</div>' +
      health +
      '<button class="btn ' + (config ? 'outline' : 'primary') + '" style="margin-top:12px;width:100%" data-configure="' + escapeHtml(service.key) + '">' +
        (config ? 'Manage' : 'Configure') + '</button>' +
    '</div>';
  }

  function bindEvents() {
    wrap.querySelectorAll('[data-filter]').forEach(b => {
      b.onclick = () => { state.filter = b.getAttribute('data-filter'); render(); };
    });
    wrap.querySelectorAll('[data-configure]').forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); openConfigModal(b.getAttribute('data-configure')); };
    });
  }

  function openConfigModal(serviceKey) {
    const service = state.available.find(s => s.key === serviceKey);
    if (!service) return;
    const config = configFor(serviceKey);
    const creds = config ? config.credentials : {};

    const body =
      (service.docs ? '<div class="alert info" style="font-size:12px;margin-bottom:14px">📖 Need help finding these? <a href="' + escapeHtml(service.docs) + '" target="_blank" rel="noopener" style="color:var(--p);font-weight:600">Open ' + escapeHtml(service.name) + ' docs ↗</a></div>' : '') +
      service.credentials.map(c => {
        const existing = creds[c.key] || '';
        const isSecret = !c.public;
        return '<div class="form-group" style="margin-bottom:12px">' +
          '<label class="form-label">' + escapeHtml(c.label) + (c.required ? ' <span style="color:var(--error)">*</span>' : ' <span style="color:var(--text3);font-weight:400">(optional)</span>') + '</label>' +
          '<input class="form-input" id="cred-' + escapeHtml(c.key) + '" ' +
            (isSecret ? 'type="password"' : 'type="text"') + ' ' +
            'placeholder="' + (existing ? escapeHtml(existing) + ' (leave blank to keep)' : 'Enter ' + escapeHtml(c.label)) + '"/>' +
        '</div>';
      }).join('') +
      '<div class="toggle-wrap" style="margin-top:8px"><div class="toggle-info"><div class="toggle-label">Test / Sandbox Mode</div>' +
        '<div class="toggle-desc">Use test credentials — no real transactions</div></div>' +
        '<label class="toggle"><input type="checkbox" id="cfg-testmode" ' + (config && config.test_mode ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
      '<div class="toggle-wrap" style="margin-top:8px"><div class="toggle-info"><div class="toggle-label">Enable</div>' +
        '<div class="toggle-desc">Make this service active for use</div></div>' +
        '<label class="toggle"><input type="checkbox" id="cfg-active" ' + (config && config.active ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>';

    const footer =
      (config ? '<button class="btn danger" onclick="window.__deleteIntegration(\'' + escapeJsInAttr(config.id) + '\')">Remove</button>' : '') +
      (config ? '<button class="btn outline" onclick="window.__testIntegration(\'' + escapeJsInAttr(config.id) + '\')">Test Connection</button>' : '') +
      '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
      '<button class="btn primary" onclick="window.__saveIntegration(\'' + escapeJsInAttr(serviceKey) + '\')">' + (config ? 'Save Changes' : 'Save & Connect') + '</button>';

    openModal(service.name + ' Setup', body, footer, { wide: false });
  }

  window.__saveIntegration = async (serviceKey) => {
    const service = state.available.find(s => s.key === serviceKey);
    const config = configFor(serviceKey);
    const credentials = {};
    service.credentials.forEach(c => {
      const val = document.getElementById('cred-' + c.key).value.trim();
      if (val) credentials[c.key] = val; // only send non-empty (blank = keep existing on update)
    });
    const testMode = document.getElementById('cfg-testmode').checked;
    const active = document.getElementById('cfg-active').checked;

    try {
      if (config) {
        await API.patch('/api/api-integrations/' + config.id, { credentials, testMode, active });
        toast('Integration updated', 'success');
      } else {
        await API.post('/api/api-integrations', { serviceKey, credentials, testMode, active });
        toast('Integration connected', 'success');
      }
      closeModal();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.__testIntegration = async (id) => {
    try {
      const result = await API.post('/api/api-integrations/' + id + '/test', {});
      toast(result.message || (result.success ? 'Connection OK' : 'Test failed'), result.success ? 'success' : 'error');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.__deleteIntegration = async (id) => {
    if (!confirm('Remove this integration? Stored credentials will be deleted.')) return;
    try {
      await API.del('/api/api-integrations/' + id);
      toast('Integration removed', 'success');
      closeModal();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  load();
  return wrap;
};
