// public/js/pages/booking-engine.js
// Booking Engine — the hotel's own public OTA channel, as a first-class page:
// config (enable, notice, daily cap), the guest-facing links, live submissions
// with one-click confirm/reject, and the direct-channel funnel numbers.
window.PAGES = window.PAGES || {};

PAGES.engine = function () {
  const wrap = el('div', 'fa');
  const state = { cfg: null, settings: null, subs: [], filter: 'pending', metrics: null };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading booking engine…');
    try {
      const [cfg, settings, bookings] = await Promise.all([
        API.get('/api/booking-engine/admin/config'),
        API.get('/api/settings'),
        API.get('/api/bookings'),
      ]);
      state.cfg = cfg;
      state.settings = settings;
      state.subs = bookings.filter(b => b.engineCode); // engine-sourced only
      try {
        state.metrics = await API.get('/api/analytics/engine');
      } catch (e) { state.metrics = null; }
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, "navigate('engine')");
    }
  }

  function statusColor(s) {
    return { confirmed: 'info', checked_in: 'success', checked_out: 'default', cancelled: 'error', pending_payment: 'warning' }[s] || 'default';
  }

  function render() {
    const sub = state.settings.subdomain || '';
    const origin = window.location.origin;
    const bookUrl = origin + '/book.html?hotel=' + encodeURIComponent(sub);
    const confUrl = origin + '/confirmation.html?hotel=' + encodeURIComponent(sub);
    const list = state.subs.filter(b => state.filter === 'all' || (state.filter === 'pending' ? (b.status === 'pending_payment' && b.engineSyncStatus === 'pending') : b.status === state.filter));

    wrap.innerHTML =
      '<div class="page-header"><div class="page-header-left"><h1>Booking Engine</h1>' +
        '<p>Your own public booking channel — synchronized with the front desk, no commission.</p></div>' +
        '<span class="badge ' + (state.cfg.enabled ? 'success' : '') + '">' + (state.cfg.enabled ? '● LIVE' : 'OFF') + '</span></div>' +

      // ── Config ──
      '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">Configuration</span></div>' +
        '<div class="toggle-wrap"><div class="toggle-info"><div class="toggle-label">Accept online bookings</div>' +
          '<div class="toggle-desc">Exposes the public booking page for this hotel</div></div>' +
          '<label class="toggle"><input type="checkbox" id="be-enabled" ' + (state.cfg.enabled ? 'checked' : '') + '><span class="toggle-slider"></span></label></div>' +
        '<div class="form-row cols-2" style="margin-top:10px">' +
          '<div class="form-group"><label class="form-label">Guest-facing notice (optional)</label>' +
            '<input class="form-input" id="be-notice" value="' + escapeHtml(state.cfg.notice || '') + '" placeholder="e.g. Breakfast included · Free cancellation up to 48h"/></div>' +
          '<div class="form-group"><label class="form-label">Max submissions per day</label>' +
            '<input class="form-input" type="number" min="1" id="be-max" value="' + (state.cfg.maxDaily || 50) + '"/></div></div>' +
        '<button class="btn primary sm" onclick="window.__beSave()">Save Configuration</button></div>' +

      // ── Links ──
      '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">Guest-facing links</span></div>' +
        '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">Booking page — put this on your website, social bios, and Google Business profile:</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px"><code style="flex:1;font-size:12px;background:var(--bg);padding:8px 10px;border-radius:8px;overflow-x:auto;white-space:nowrap">' + escapeHtml(bookUrl) + '</code>' +
          '<button class="btn outline sm" onclick="window.__beCopy(window.__beBookUrl)">Copy</button>' +
          '<a class="btn ghost sm" href="' + escapeHtml(bookUrl) + '" target="_blank" rel="noopener">Open ↗</a></div>' +
        '<div style="font-size:12px;color:var(--text3);margin-bottom:6px">Guest confirmation lookup (code / reference + phone) — link it in the booking confirmation message:</div>' +
        '<div style="display:flex;gap:8px;align-items:center"><code style="flex:1;font-size:12px;background:var(--bg);padding:8px 10px;border-radius:8px;overflow-x:auto;white-space:nowrap">' + escapeHtml(confUrl) + '</code>' +
          '<button class="btn outline sm" onclick="window.__beCopy(window.__beConfUrl)">Copy</button>' +
          '<a class="btn ghost sm" href="' + escapeHtml(confUrl) + '" target="_blank" rel="noopener">Open ↗</a></div></div>' +

      // ── Funnel ──
      (state.metrics ?
        '<div class="grid grid-4" style="margin-bottom:16px">' +
          metricCard('Submissions', String(state.metrics.submissions), null, '📥') +
          metricCard('Confirmed', String(state.metrics.confirmed), null, '✅') +
          metricCard('Confirmation Rate', state.metrics.confirmRate === null ? '—' : state.metrics.confirmRate + '%', null, '📈') +
          metricCard('Confirmed Revenue', formatMoney(state.metrics.confirmedRevenue), null, '💰') +
        '</div>' : '') +

      // ── Submissions ──
      '<div class="filter-pills" style="margin-bottom:14px">' +
        ['pending', 'confirmed', 'cancelled', 'all'].map(f =>
          '<button class="pill ' + (state.filter === f ? 'active' : '') + '" onclick="window.__beFilter(\'' + f + '\')">' +
            f.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) + (f === 'pending' ? ' (' + state.subs.filter(b => b.status === 'pending_payment' && b.engineSyncStatus === 'pending').length + ')' : '') + '</button>').join('') +
      '</div>' +
      (list.length === 0
        ? '<div class="empty-state"><div class="empty-state-icon">🛎️</div><div class="empty-state-title">No ' + escapeHtml(state.filter) + ' submissions</div>' +
          '<div class="empty-state-desc">' + (state.cfg.enabled ? 'Share your booking page — new submissions land here instantly.' : 'Enable the engine above to start taking bookings.') + '</div></div>'
        : '<div style="display:flex;flex-direction:column;gap:10px">' + list.map(b => {
            const pending = b.status === 'pending_payment' && b.engineSyncStatus === 'pending';
            return '<div class="card" style="padding:14px 18px">' +
              (pending ? '<div style="background:var(--warn-bg);border:1.5px solid var(--warn-border);border-radius:var(--radius);padding:8px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
                '<span style="font-size:11px;font-weight:700;color:var(--text3)">TENDER CODE</span>' +
                '<span style="font-family:monospace;font-weight:800;font-size:15px;letter-spacing:2px;color:var(--p)">' + escapeHtml(b.engineCode || '—') + '</span>' +
                '<span style="flex:1"></span>' +
                '<button class="btn primary sm" onclick="window.__beConfirm(\'' + b.id + '\')">✓ Confirm</button>' +
                '<button class="btn danger sm" onclick="window.__beReject(\'' + b.id + '\')">Reject</button></div>' : '') +
              '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
                '<div style="flex:1;min-width:180px"><div style="font-weight:700;font-size:14px">' + escapeHtml(b.guest_name || '') + '</div>' +
                  '<div style="font-size:12px;color:var(--text3)">' + escapeHtml(b.reference) + ' · ' + escapeHtml(b.guest_phone || '') + '</div></div>' +
                '<div style="font-size:12px;text-align:center;min-width:120px">' + fmtDate_(b.check_in) + ' → ' + fmtDate_(b.check_out) + '</div>' +
                '<div style="text-align:right;min-width:100px"><div style="font-weight:800;color:var(--p)">' + formatMoney(b.total_amount) + '</div>' +
                  '<div style="font-size:11px;color:var(--text3)">' + (b.rooms || []).map(r => r.room_number).join(', ') + '</div></div>' +
                statusBadge(b.status) +
              '</div></div>';
          }).join('') + '</div>');

    window.__beBookUrl = bookUrl;
    window.__beConfUrl = confUrl;
  }

  function fmtDate_(d) { return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }

  window.__beCopy = (text) => {
    navigator.clipboard.writeText(text).then(() => toast('Link copied', 'success'), () => toast('Copy failed', 'error'));
  };
  window.__beFilter = (f) => { state.filter = f; render(); };
  window.__beSave = async () => {
    try {
      const saved = await API.put('/api/booking-engine/admin/config', {
        enabled: document.getElementById('be-enabled').checked,
        notice: document.getElementById('be-notice').value.trim(),
        maxDaily: parseInt(document.getElementById('be-max').value, 10) || 50,
      });
      state.cfg = saved;
      toast('Booking engine ' + (saved.enabled ? 'enabled — your booking page is live' : 'disabled'), 'success');
      render();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__beConfirm = (id) => {
    confirmAction('Confirm this online booking? The room will be held for the guest.', async () => {
      try { await API.post('/api/bookings/' + id + '/confirm'); toast('Online booking confirmed', 'success'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };
  window.__beReject = (id) => {
    confirmAction('Reject this online booking? The guest will be notified to contact the hotel.', async () => {
      try { await API.post('/api/bookings/' + id + '/reject', { reason: 'rejected at front desk' }); toast('Booking rejected', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
