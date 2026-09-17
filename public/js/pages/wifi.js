// public/js/pages/wifi.js
// Guest Wi-Fi — per-room internet sessions tied to bookings.
// Staff with bookings.manage provision on check-in, extend for late stays,
// revoke on early departure. Includes the printable guest key card.
window.PAGES = window.PAGES || {};

PAGES.wifi = function () {
  const wrap = el('div', 'fa');
  const state = { sessions: [], filter: 'active' };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading Wi-Fi sessions…');
    try {
      state.sessions = await API.get('/api/wifi');
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, "navigate('wifi')");
    }
  }

  function render() {
    const sessions = state.sessions.filter(s => state.filter === 'all' || s.status === state.filter);
    wrap.innerHTML =
      '<div class="page-header"><div class="page-header-left"><h1>Guest Wi-Fi</h1>' +
        '<p>Per-room internet sessions. Provisioned automatically on check-in; extend for late stays, revoke on early departure.</p></div>' +
        '<button class="btn outline sm" onclick="window.__wifiProvision()">＋ Provision for Booking</button></div>' +
      '<div style="display:flex;gap:8px;margin-bottom:16px">' +
        ['active', 'revoked', 'all'].map(f =>
          '<button class="chip' + (state.filter === f ? ' active' : '') + '" data-wf="' + f + '" ' +
          'style="padding:6px 14px;border-radius:20px;border:1.5px solid ' + (state.filter === f ? 'var(--p)' : 'var(--border)') + ';' +
          'background:' + (state.filter === f ? 'var(--p)' : 'var(--surface)') + ';color:' + (state.filter === f ? '#fff' : 'var(--text)') + ';cursor:pointer;font-size:13px;font-weight:600">' +
          f.charAt(0).toUpperCase() + f.slice(1) + '</button>').join('') +
      '</div>' +
      (sessions.length === 0
        ? '<div class="card" style="padding:40px;text-align:center;color:var(--text3)">No ' + escapeHtml(state.filter) + ' sessions. Wi-Fi is created automatically when a booking is checked in — configure a controller under API Integrations → Internet Management to push credentials to your network gear.</div>'
        : '<div class="table-wrap"><table><thead><tr><th>Room</th><th>Guest</th><th>Controller</th><th>Speed</th><th>Status</th><th>Expires</th><th style="width:180px"></th></tr></thead><tbody>' +
          sessions.map(s =>
            '<tr>' +
              '<td style="font-weight:700">' + escapeHtml(s.roomNumber || '—') + '</td>' +
              '<td>' + escapeHtml(s.guestName || '—') + '</td>' +
              '<td><span style="font-size:12px;color:var(--text3)">' + escapeHtml(s.controller) + '</span></td>' +
              '<td style="font-size:12px">' + (s.speedDownMbps || '—') + '↓ / ' + (s.speedUpMbps || '—') + '↑ Mbps' + (s.quotaGb ? ' · ' + s.quotaGb + 'GB' : '') + '</td>' +
              '<td>' + (s.status === 'active' ? '<span style="color:var(--success);font-weight:600">● Active</span>' : '<span style="color:var(--text3)">' + escapeHtml(s.status) + '</span>') + '</td>' +
              '<td style="font-size:12px;color:var(--text3)">' + (s.expiresAt ? String(s.expiresAt).slice(0, 16) : '—') + '</td>' +
              '<td style="text-align:right">' +
                (s.status === 'active'
                  ? '<button class="btn outline sm" onclick="window.__wifiDetails(\'' + s.id + '\')">Credentials</button> ' +
                    '<button class="btn ghost sm" onclick="window.__wifiRevoke(\'' + s.id + '\')">Revoke</button>'
                  : '<button class="btn ghost sm" onclick="window.__wifiDetails(\'' + s.id + '\')">View</button>') +
              '</td>' +
            '</tr>').join('') +
        '</tbody></table></div>');

    wrap.querySelectorAll('[data-wf]').forEach(b => {
      b.onclick = () => { state.filter = b.getAttribute('data-wf'); render(); };
    });
  }

  window.__wifiDetails = async (id) => {
    try {
      const s = await API.get('/api/wifi/' + id);
      openModal('Wi-Fi Credentials — Room ' + escapeHtml(s.roomNumber || ''),
        '<div class="card" style="padding:18px;background:var(--bg);font-family:monospace;font-size:15px;line-height:2">' +
          '<div style="font-family:inherit;font-size:12px;color:var(--text3);margin-bottom:6px">GUEST Wi-Fi</div>' +
          '<div>Network: <b>' + escapeHtml(s.identity) + '</b></div>' +
          '<div>Password: <b id="wf-pass">' + escapeHtml(s.password || '—') + '</b></div>' +
          '<div style="font-family:inherit;font-size:12px;color:var(--text3);margin-top:8px">' +
            'Speed: ' + (s.speedDownMbps || '—') + '↓ / ' + (s.speedUpMbps || '—') + '↑ Mbps' +
            (s.quotaGb ? ' · ' + s.quotaGb + 'GB cap' : '') + ' · Valid until ' + (s.expiresAt ? String(s.expiresAt).slice(0, 16) : '—') +
          '</div>' +
        '</div>' +
        '<p style="font-size:11px;color:var(--text3)">Guests can retrieve these credentials themselves at <b>/wifi.html</b> with their room number and booking reference.</p>',
        '<button class="btn outline" onclick="window.print()">Print</button>' +
        '<button class="btn primary" onclick="closeModal()">Done</button>'
      );
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__wifiRevoke = (id) => {
    confirmAction('Revoke this guest\'s internet access?', async () => {
      try { await API.post('/api/wifi/' + id + '/revoke', { reason: 'staff revoked' }); toast('Session revoked', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__wifiProvision = () => {
    navigate('bookings');
    toast('Open a booking and use "Wi-Fi" to provision its session', 'info');
  };

  load();
  return wrap;
};
