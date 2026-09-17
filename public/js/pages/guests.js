// public/js/pages/guests.js
window.PAGES = window.PAGES || {};

PAGES.guests = function () {
  const wrap = el('div', 'fa');
  const state = { guests: [] };

  function tierBadgeType(t) { return t === 'Platinum' ? 'dark' : t === 'Gold' ? 'warn' : 'default'; }

  async function load() {
    wrap.innerHTML = loaderHTML('Loading guests…');
    try {
      state.guests = await API.get('/api/guests');
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'guests\')'); }
  }

  function render() {
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Guest Profiles</h1><p>' + state.guests.length + ' guest records</p></div>' +
      '<button class="btn primary" onclick="window.__openAddGuest()">+ Add Guest</button></div>' +
    '<div class="table-wrap"><table><thead><tr><th>Guest</th><th>Room</th><th>Loyalty</th><th>Points</th><th>Stays</th><th>Total Spent</th><th>Check-in</th><th>Check-out</th><th>Actions</th></tr></thead><tbody>' +
      (state.guests.length === 0 ? '<tr><td colspan="9" style="text-align:center;color:var(--text3);padding:30px">No guests yet</td></tr>' : '') +
      state.guests.map(g => '<tr>' +
        '<td><div style="font-weight:600">' + escapeHtml(g.name) + '</div><div style="font-size:11px;color:var(--text3)">' + escapeHtml(g.phone || '') + '</div></td>' +
        '<td><span style="font-family:var(--font-mono);font-weight:700;color:var(--p)">' + escapeHtml(g.room_number || '—') + '</span></td>' +
        '<td>' + badge(g.loyalty_tier, tierBadgeType(g.loyalty_tier)) + '</td>' +
        '<td><span style="font-family:var(--font-mono)">' + g.loyalty_points.toLocaleString() + '</span></td>' +
        '<td>' + g.stays + '</td><td style="font-weight:600;color:var(--p)">' + formatMoney(g.total_spent) + '</td>' +
        '<td><span style="font-size:12px">' + escapeHtml(g.check_in_date || '—') + '</span></td><td><span style="font-size:12px">' + escapeHtml(g.check_out_date || '—') + '</span></td>' +
        '<td><button class="btn ghost sm" onclick="window.__viewGuest(\'' + g.id + '\')">View</button><button class="btn ghost sm" onclick="window.__editGuest(\'' + g.id + '\')">Edit</button></td>' +
      '</tr>').join('') +
    '</tbody></table></div>';
  }

  window.__viewGuest = (id) => {
    const g = state.guests.find(x => x.id === id);
    if (!g) return;
    const prefs = g.preferences || [];
    const rows = [['Phone', g.phone], ['Email', g.email], ['Room', g.room_number || 'N/A'], ['Loyalty Tier', g.loyalty_tier],
      ['Loyalty Points', g.loyalty_points.toLocaleString()], ['Total Stays', g.stays], ['Total Spent', formatMoney(g.total_spent)], ['Preferences', prefs.join(', ') || 'None']];
    openModal(escapeHtml(g.name),
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">' + rows.map(r => '<div><div style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;margin-bottom:3px">' + r[0] + '</div><div style="font-size:14px;font-weight:500">' + escapeHtml(String(r[1] || '—')) + '</div></div>').join('') + '</div>' +
      '<div style="margin-top:16px;display:flex;gap:10px"><button class="btn primary sm" onclick="toast(\'WhatsApp opened for ' + escapeJsInAttr(g.name) + '\',\'success\')">WhatsApp</button><button class="btn accent sm" onclick="window.__addLoyaltyPoints(\'' + id + '\')">Add 100 Points</button></div>',
      '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__editGuest(\'' + id + '\');closeModal()">Edit Profile</button>'
    );
  };
  window.__addLoyaltyPoints = async (id) => {
    try { await API.post('/api/guests/' + id + '/loyalty/add', { points: 100 }); toast('+100 loyalty points added', 'success'); await load(); closeModal(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__editGuest = (id) => {
    const g = state.guests.find(x => x.id === id);
    if (!g) return;
    openModal('Edit Guest Profile',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="eg-name" value="' + escapeHtml(g.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="eg-phone" value="' + escapeHtml(g.phone || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" id="eg-email" value="' + escapeHtml(g.email || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Room</label><input class="form-input" id="eg-room" value="' + escapeHtml(g.room_number || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Loyalty Tier</label><select class="form-select" id="eg-tier">' + ['Bronze','Silver','Gold','Platinum'].map(t => '<option' + (g.loyalty_tier === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Loyalty Points</label><input class="form-input" type="number" id="eg-pts" value="' + g.loyalty_points + '"/></div>' +
        '<div class="form-group"><label class="form-label">Check-in Date</label><input class="form-input" id="eg-ci" value="' + escapeHtml(g.check_in_date || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Check-out Date</label><input class="form-input" id="eg-co" value="' + escapeHtml(g.check_out_date || '') + '"/></div></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger sm" onclick="window.__deleteGuest(\'' + id + '\')">Delete</button><button class="btn primary" onclick="window.__saveGuest(\'' + id + '\')">Save</button>'
    );
  };
  window.__saveGuest = async (id) => {
    try {
      await API.patch('/api/guests/' + id, {
        name: document.getElementById('eg-name').value, phone: document.getElementById('eg-phone').value, email: document.getElementById('eg-email').value,
        roomNumber: document.getElementById('eg-room').value, loyaltyTier: document.getElementById('eg-tier').value, loyaltyPoints: Number(document.getElementById('eg-pts').value),
        checkInDate: document.getElementById('eg-ci').value, checkOutDate: document.getElementById('eg-co').value,
      });
      toast('Guest profile updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteGuest = (id) => {
    confirmAction('Delete this guest profile?', async () => {
      try { await API.del('/api/guests/' + id); toast('Guest deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__openAddGuest = () => {
    openModal('Add Guest',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="ag-name" placeholder="e.g. Mr. Johnson"/></div>' +
        '<div class="form-group"><label class="form-label">Phone (WhatsApp)</label><input class="form-input" id="ag-phone" placeholder="+1 555 0000"/></div>' +
        '<div class="form-group"><label class="form-label">Email</label><input class="form-input" type="email" id="ag-email" placeholder="guest@email.com"/></div>' +
        '<div class="form-group"><label class="form-label">Room Number</label><input class="form-input" id="ag-room" placeholder="e.g. 301"/></div>' +
        '<div class="form-group"><label class="form-label">Check-in</label><input class="form-input" id="ag-ci" placeholder="Oct 25"/></div>' +
        '<div class="form-group"><label class="form-label">Check-out</label><input class="form-input" id="ag-co" placeholder="Oct 28"/></div></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addGuest()">Add Guest</button>'
    );
  };
  window.__addGuest = async () => {
    const name = document.getElementById('ag-name').value.trim();
    if (!name) { toast('Name required', 'error'); return; }
    try {
      await API.post('/api/guests', {
        name, phone: document.getElementById('ag-phone').value, email: document.getElementById('ag-email').value,
        roomNumber: document.getElementById('ag-room').value, checkInDate: document.getElementById('ag-ci').value, checkOutDate: document.getElementById('ag-co').value,
      });
      toast('Guest added', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
