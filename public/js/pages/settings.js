// public/js/pages/settings.js
window.PAGES = window.PAGES || {};

PAGES.settings = function () {
  const wrap = el('div', 'fa');
  let settings = {};

  async function load() {
    wrap.innerHTML = loaderHTML('Loading settings…');
    try { settings = await API.get('/api/settings'); render(); }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'settings\')'); }
  }

  function render() {
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Settings</h1><p>Configure your hotel\'s automation and integrations</p></div>' +
      '<button class="btn primary" onclick="window.__saveAllSettings()">Save All Changes</button></div>' +
    '<div style="max-width:720px;display:flex;flex-direction:column;gap:24px">' +
      '<div class="card"><div class="card-header"><span class="card-title">Hotel Profile</span></div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Hotel Name</label><input class="form-input" id="set-name" value="' + escapeHtml(settings.name || '') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Currency</label><select class="form-select" id="set-currency">' + ['$','€','£','₦','GHS','KES'].map(c => '<option' + (settings.currency === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
          '<div class="form-group"><label class="form-label">Check-in Time</label><input class="form-input" type="time" id="set-cin" value="' + (settings.checkInTime || '14:00') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Check-out Time</label><input class="form-input" type="time" id="set-cout" value="' + (settings.checkOutTime || '11:00') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Timezone</label><select class="form-select" id="set-tz">' + ['UTC','UTC+1','UTC+2','UTC+3','UTC-5','UTC-8'].map(t => '<option' + (settings.timezone === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div></div></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">WhatsApp Business API</span>' + (settings.waConnected ? '<span class="badge success">Connected</span>' : '<span class="badge error">Not Connected</span>') + '</div>' +
        '<div class="alert info" style="font-size:12px">To receive real WhatsApp messages, set your webhook URL in Meta\'s Developer Console to:<br/><code>' + window.location.origin + '/api/webhooks/whatsapp/' + escapeHtml(settings.subdomain || 'your-subdomain') + '</code></div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">WhatsApp Phone Number</label><input class="form-input" id="set-waphone" value="' + escapeHtml(settings.waPhone || '') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Phone Number ID</label><input class="form-input" id="set-waphoneid" placeholder="From Meta Developer Console"/></div>' +
          '<div class="form-group"><label class="form-label">Access Token</label><input class="form-input" type="password" id="set-watoken" placeholder="Permanent or temp token"/></div>' +
          '<div class="form-group"><label class="form-label">Webhook Verify Token</label><input class="form-input" id="set-waverify" placeholder="Any string you choose"/></div></div>' +
        '<div style="display:flex;gap:10px;margin-top:8px"><button class="btn accent" onclick="toast(\'Save settings to test the connection\',\'info\')">Test Connection</button></div></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">AI Receptionist</span></div>' +
        '<div class="toggle-wrap" style="margin-bottom:8px"><div class="toggle-info"><div class="toggle-label">Enable AI Receptionist</div><div class="toggle-desc">Automatically respond to guest WhatsApp messages</div></div><label class="toggle"><input type="checkbox" id="set-ai" ' + (settings.aiEnabled ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
        '<div class="toggle-wrap" style="margin-bottom:14px"><div class="toggle-info"><div class="toggle-label">Auto-Booking</div><div class="toggle-desc">Allow AI to confirm and finalize room bookings</div></div><label class="toggle"><input type="checkbox" id="set-autobk" ' + (settings.autoBooking ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
        '<div class="form-group"><label class="form-label">Response Tone</label><select class="form-select" id="set-tone">' + ['Professional','Friendly','Luxury Concierge','Formal'].map(t => '<option' + (settings.aiTone === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">Departmental Rules</span></div>' +
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">' +
          '<div style="background:var(--surface2);border-radius:var(--radius);padding:13px;border:1px solid var(--border)"><div style="font-weight:700;font-size:13px;margin-bottom:10px">Housekeeping</div>' +
            '<div class="toggle-wrap" style="padding:0;border:none;background:transparent"><div class="toggle-info"><div class="toggle-label" style="font-size:12px">Auto-assign on checkout</div></div><label class="toggle"><input type="checkbox" id="set-hk-auto" ' + (settings.autoAssignHk ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
            '<div class="form-group" style="margin-top:10px"><label class="form-label">SLA (minutes)</label><input class="form-input" type="number" id="set-hk-sla" value="' + (settings.housekeepingSla || 45) + '"/></div></div>' +
          '<div style="background:var(--surface2);border-radius:var(--radius);padding:13px;border:1px solid var(--border)"><div style="font-weight:700;font-size:13px;margin-bottom:10px">Maintenance</div>' +
            '<div class="toggle-wrap" style="padding:0;border:none;background:transparent"><div class="toggle-info"><div class="toggle-label" style="font-size:12px">Auto-assign requests</div></div><label class="toggle"><input type="checkbox" id="set-mnt-auto" ' + (settings.autoAssignMaint ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
            '<div class="form-group" style="margin-top:10px"><label class="form-label">SLA (minutes)</label><input class="form-input" type="number" id="set-mnt-sla" value="' + (settings.maintenanceSla || 60) + '"/></div></div></div></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">Point of Sale &amp; Pool</span></div>' +
        '<p style="font-size:12px;color:var(--text3);margin-bottom:14px">Default tax and service charge applied to new Restaurant &amp; Bar tickets, and the concurrent guest capacity for Pool Bookings.</p>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Tax Rate (%)</label><input class="form-input" type="number" min="0" max="100" step="0.5" id="set-pos-tax" value="' + (settings.posTaxPct || 0) + '"/></div>' +
          '<div class="form-group"><label class="form-label">Service Charge (%)</label><input class="form-input" type="number" min="0" max="100" step="0.5" id="set-pos-service" value="' + (settings.posServicePct || 0) + '"/></div>' +
          '<div class="form-group"><label class="form-label">Pool Capacity (guests)</label><input class="form-input" type="number" min="1" id="set-pool-capacity" value="' + (settings.poolCapacity || 20) + '"/></div></div></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">Printers</span></div>' +
        '<p style="font-size:12px;color:var(--text3);margin-bottom:14px">Set up thermal receipt printers (80mm/58mm) for Restaurant &amp; Bar, and an A4 printer for the front desk.</p>' +
        '<button class="btn outline" onclick="navigate(\'printers\')">Manage Printers →</button></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">Accepted Payment Methods</span></div>' +
        '<p style="font-size:12px;color:var(--text3);margin-bottom:14px">Choose which payment modes your front desk, POS, and other services can offer guests at checkout. Owner/manager only.</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:14px">' +
          [['cash','Cash'],['card','Card'],['pos','POS Terminal'],['bank_transfer','Bank Transfer'],['check','Check'],['crypto','Cryptocurrency'],['paypal','PayPal'],['payoneer','Payoneer'],['airtm','Airtm'],['mobile_transfer','Mobile Transfer'],['offline','Offline / Other']].map(([val, label]) =>
            '<label style="display:flex;align-items:center;gap:8px;font-size:12px;background:var(--surface2);border-radius:8px;padding:8px 10px"><input type="checkbox" class="set-paymethod" value="' + val + '" ' + ((settings.paymentMethods || []).includes(val) ? 'checked' : '') + '/>' + label + '</label>'
          ).join('') +
        '</div>' +
        '<button class="btn outline sm" onclick="window.__openPaymentMethodConfig()">Configure Account Details →</button></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">Payment Gateways</span></div>' +
        '<div class="form-row cols-2">' +
          '<div class="form-group"><label class="form-label">Paystack Public Key</label><input class="form-input" id="set-ps-pub" value="' + escapeHtml(settings.paystackPublicKey || '') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Paystack Secret Key</label><input class="form-input" type="password" id="set-ps-secret" placeholder="' + (settings.paystackSecretSet ? '••••••••••••••••' : 'Not set') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Stripe Public Key</label><input class="form-input" id="set-stripe-pub" value="' + escapeHtml(settings.stripePublicKey || '') + '"/></div>' +
          '<div class="form-group"><label class="form-label">Stripe Secret Key</label><input class="form-input" type="password" id="set-stripe-secret" placeholder="' + (settings.stripeSecretSet ? '••••••••••••••••' : 'Not set') + '"/></div></div></div>' +

      '<div class="card"><div class="card-header"><span class="card-title">Booking Engine (public)</span>' + (settings.engineEnabled ? '<span class="badge success">Live</span>' : '<span class="badge">Off</span>') + '</div>' +
        '<div class="alert info" style="font-size:12px">Guests book themselves at <code>/book.html?hotel=' + escapeHtml(settings.subdomain || 'your-subdomain') + '</code>. Submissions appear in Bookings with a code the guest presents at the desk; confirming it reserves the room.</div>' +
        '<div class="toggle-wrap"><div class="toggle-info"><div class="toggle-label">Accept online bookings</div><div class="toggle-desc">Expose the public booking page for this hotel</div></div>' +
          '<label class="toggle"><input type="checkbox" id="set-engine-enabled" ' + (settings.engineEnabled ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
        '<div class="form-row cols-2" style="margin-top:10px">' +
          '<div class="form-group"><label class="form-label">Guest-facing notice (optional)</label><input class="form-input" id="set-engine-notice" value="' + escapeHtml(settings.engineNotice || '') + '" placeholder="e.g. Breakfast included · Pool closes 6pm"/></div>' +
          '<div class="form-group"><label class="form-label">Max submissions per day</label><input class="form-input" type="number" min="1" id="set-engine-max" value="' + (settings.engineMaxDaily || 50) + '"/></div></div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:6px"><button class="btn outline sm" onclick="window.__saveEngineConfig()">Save Booking Engine</button>' +
        '<a href="/book.html?hotel=' + escapeHtml(settings.subdomain || '') + '" target="_blank" rel="noopener" class="btn ghost sm">Preview booking page ↗</a></div></div>' +

      '<div style="background:var(--error-bg);border:1.5px solid var(--error-border);border-radius:var(--radius-lg);padding:18px">' +
        '<div style="font-weight:700;color:var(--error);margin-bottom:8px">Danger Zone</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:16px"><p style="font-size:13px;color:var(--text3)">Permanently delete all operational data (rooms, guests, orders, staff, etc). Your hotel profile and login stay intact.</p>' +
        '<button class="btn danger sm" onclick="window.__doFactoryReset()">Factory Reset</button></div></div>' +
    '</div>';
  }

  const PAYMENT_CONFIG_FIELDS = {
    bank_transfer: [['bankName', 'Bank Name'], ['accountName', 'Account Name'], ['accountNumber', 'Account Number'], ['routingInfo', 'Routing / Sort Code (optional)']],
    paypal: [['email', 'PayPal Email']],
    payoneer: [['email', 'Payoneer Email']],
    airtm: [['handle', 'Airtm Username / Email']],
    mobile_transfer: [['provider', 'Mobile Money Provider'], ['number', 'Phone Number']],
    offline: [['instructions', 'Instructions for Guests']],
  };

  window.__openPaymentMethodConfig = () => {
    const configs = settings.paymentMethodConfigs || {};
    const relevant = Object.keys(PAYMENT_CONFIG_FIELDS).filter(m => (settings.paymentMethods || []).includes(m));
    if (relevant.length === 0) {
      openModal('Configure Payment Methods', '<p style="font-size:13px;color:var(--text3)">Enable Bank Transfer, PayPal, Payoneer, Airtm, Mobile Transfer, or Offline above first, then come back here to add their account details.</p>', '<button class="btn outline" onclick="closeModal()">Close</button>');
      return;
    }
    openModal('Configure Payment Methods',
      relevant.map(m => {
        const label = { bank_transfer: 'Bank Transfer', paypal: 'PayPal', payoneer: 'Payoneer', airtm: 'Airtm', mobile_transfer: 'Mobile Transfer', offline: 'Offline / Other' }[m];
        const cfg = configs[m] || {};
        return '<div style="margin-bottom:16px"><div style="font-weight:700;font-size:13px;margin-bottom:8px">' + label + '</div>' +
          '<div class="form-row cols-2">' + PAYMENT_CONFIG_FIELDS[m].map(([key, flabel]) =>
            '<div class="form-group"><label class="form-label">' + flabel + '</label><input class="form-input" data-pmc="' + m + '" data-pmk="' + key + '" value="' + escapeHtml(cfg[key] || '') + '"/></div>'
          ).join('') + '</div></div>';
      }).join(''),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__savePaymentMethodConfig()">Save Configuration</button>',
      { wide: true }
    );
  };
  window.__savePaymentMethodConfig = async () => {
    const configs = {};
    document.querySelectorAll('[data-pmc]').forEach(input => {
      const m = input.dataset.pmc, k = input.dataset.pmk;
      configs[m] = configs[m] || {};
      configs[m][k] = input.value.trim();
    });
    try {
      settings = await API.patch('/api/settings', { paymentMethodConfigs: configs });
      toast('Payment method details saved', 'success'); closeModal(); render();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__saveAllSettings = async () => {
    const body = {
      hotelName: val('set-name'), currency: val('set-currency'), checkInTime: val('set-cin'), checkOutTime: val('set-cout'), timezone: val('set-tz'),
      waPhone: val('set-waphone'), aiEnabled: checked('set-ai'), autoBooking: checked('set-autobk'), aiTone: val('set-tone'),
      autoAssignHk: checked('set-hk-auto'), autoAssignMaint: checked('set-mnt-auto'),
      housekeepingSla: Number(val('set-hk-sla') || 45), maintenanceSla: Number(val('set-mnt-sla') || 60),
      posTaxPct: Number(val('set-pos-tax') || 0), posServicePct: Number(val('set-pos-service') || 0),
      poolCapacity: Number(val('set-pool-capacity') || 20),
      paymentMethods: Array.from(document.querySelectorAll('.set-paymethod:checked')).map(el => el.value),
      paystackPublicKey: val('set-ps-pub'), stripePublicKey: val('set-stripe-pub'),
    };
    if (val('set-waphoneid')) body.waPhoneId = val('set-waphoneid');
    if (val('set-watoken')) body.waToken = val('set-watoken');
    if (val('set-waverify')) body.waVerifyToken = val('set-waverify');
    if (val('set-ps-secret')) body.paystackSecretKey = val('set-ps-secret');
    if (val('set-stripe-secret')) body.stripeSecretKey = val('set-stripe-secret');

    try {
      settings = await API.patch('/api/settings', body);
      if (window.App && App.tenant) {
        App.tenant.currency = settings.currency;
        App.tenant.name = settings.name || App.tenant.name;
        const sbRole = document.getElementById('sb-user-role');
        if (sbRole) sbRole.textContent = App.tenant.name;
      }
      toast('All settings saved', 'success'); render();
    }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__saveEngineConfig = async () => {
    const enabled = document.getElementById('set-engine-enabled').checked;
    const notice = document.getElementById('set-engine-notice').value.trim();
    const maxDaily = parseInt(document.getElementById('set-engine-max').value, 10) || 50;
    try {
      const saved = await API.put('/api/booking-engine/admin/config', { enabled, notice, maxDaily });
      settings.engineEnabled = saved.enabled;
      settings.engineNotice = saved.notice;
      settings.engineMaxDaily = saved.maxDaily;
      toast('Booking engine ' + (saved.enabled ? 'enabled — your public booking page is live' : 'disabled'), 'success');
      render();
    } catch (err) { toast(err.message, 'error'); }
  };

  function val(id) { const e = document.getElementById(id); return e ? e.value : undefined; }
  function checked(id) { const e = document.getElementById(id); return e ? e.checked : undefined; }

  window.__doFactoryReset = () => {
    confirmAction('This will erase all operational data permanently. Are you absolutely sure?', async () => {
      try { await API.post('/api/settings/factory-reset', {}); toast('Factory reset done', 'warn'); navigate('dashboard'); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
