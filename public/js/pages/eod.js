// public/js/pages/eod.js
// End of Day — each department closes its own day against real, aggregated
// system totals (not hand-typed numbers).
//
// Two views, driven by permission:
//   - eod.manage users (owner/admin): the full management overview — every
//     user's closings, per-user and grand totals, reopen controls.
//   - everyone else: MY End of Day — only their own closings and a Close
//     button for their own department. Other staff's numbers are invisible.
window.PAGES = window.PAGES || {};

const DEPARTMENT_LABELS = {
  front_desk: 'Front Desk / Receptionist', restaurant: 'Restaurant', bar: 'Bar',
  pool: 'Pool', hall: 'Halls & Events', misc_services: 'Other Services (Laundry, Shoe Care, Car Service…)',
};
const DEPARTMENT_ICONS = { front_desk: '🛎', restaurant: '🍽', bar: '🍸', pool: '🏊', hall: '🎪', misc_services: '🧺' };

PAGES.eod = function () {
  const wrap = el('div', 'fa');
  const state = { date: new Date().toISOString().slice(0, 10), closings: [], mine: null, overview: null };
  const canManageAll = typeof can === 'function' ? can('eod.manage') : true;

  async function load() {
    wrap.innerHTML = loaderHTML('Loading end of day…');
    try {
      if (canManageAll) {
        const [closings, overview] = await Promise.all([
          API.get('/api/eod?date=' + state.date),
          API.get('/api/eod/overview?date=' + state.date).catch(() => null),
        ]);
        state.closings = closings; state.overview = overview;
      } else {
        const mine = await API.get('/api/eod/mine?date=' + state.date);
        state.mine = mine; state.closings = mine.closings;
      }
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'eod\')'); }
  }

  function render() {
    if (canManageAll) return renderManager();
    return renderStaff();
  }

  // ── Staff view: "My End of Day" ────────────────────────────────────────
  function renderStaff() {
    const mine = state.mine || { department: 'front_desk', closings: [] };
    const myClosing = mine.closings.find(c => c.department === mine.department);
    const closedTotal = mine.closings.reduce((s, c) => s + (c.totals.grossTotal || 0), 0);

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>My End of Day</h1><p>' + fmtDate(state.date) +
      ' &middot; your personal closings — each staff member sees only their own</p></div></div>' +
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">' +
      '<input type="date" class="form-input" style="max-width:180px" value="' + state.date + '" onchange="window.__eodDateChange(this.value)"/>' +
      '<button class="btn outline sm" onclick="window.__eodDateChange(\'' + new Date().toISOString().slice(0, 10) + '\')">Today</button>' +
    '</div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      metricCard('My Recorded Revenue', formatMoney(closedTotal), null, '🌙') +
      metricCard('My Department', DEPARTMENT_LABELS[mine.department] || mine.department, null, DEPARTMENT_ICONS[mine.department] || '🛎') +
    '</div>' +
    '<div class="grid grid-3">' +
      // My department's closing card (or the close button).
      '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span style="font-size:22px">' + (DEPARTMENT_ICONS[mine.department] || '🛎') + '</span>' +
          '<div style="font-weight:700;font-size:14px">' + (DEPARTMENT_LABELS[mine.department] || mine.department) + '</div></div>' +
        (myClosing
          ? '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Closed by ' + escapeHtml(myClosing.closed_by || 'you') + '</div>' +
            '<div style="font-weight:800;font-size:20px;color:var(--p);margin-bottom:10px">' + formatMoney(myClosing.totals.grossTotal || 0) + '</div>' +
            (myClosing.status === 'reopened'
              ? badge('Reopened — needs your attention', 'warn')
              : badge('Closed', 'success')) +
            (myClosing.status === 'reopened' ? '<button class="btn primary full" style="margin-top:10px" onclick="window.__openCloseDept(\'' + myClosing.department + '\')">Close again</button>' : '')
          : '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Not closed yet for ' + fmtDate(state.date) + '.</div>' +
            '<button class="btn primary full" onclick="window.__openCloseDept(\'' + mine.department + '\')">Close my day</button>') +
      '</div>' +
      // Any other closings this user personally made (e.g. before a dept change).
      mine.closings.filter(c => c.department !== mine.department).map(c =>
        '<div class="card">' +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span style="font-size:22px">' + (DEPARTMENT_ICONS[c.department] || '🛎') + '</span>' +
            '<div style="font-weight:700;font-size:14px">' + (DEPARTMENT_LABELS[c.department] || c.department) + '</div></div>' +
          '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Closed by ' + escapeHtml(c.closed_by || 'you') + '</div>' +
          '<div style="font-weight:800;font-size:20px;color:var(--p);margin-bottom:10px">' + formatMoney(c.totals.grossTotal || 0) + '</div>' +
          (c.status === 'reopened' ? badge('Reopened', 'warn') : badge('Closed', 'success')) +
        '</div>').join('') +
    '</div>';
  }

  // ── Manager view: full-day overview of every user's closings ───────────
  function renderManager() {
    const closedTotal = state.closings.reduce((s, c) => s + (c.totals.grossTotal || 0), 0);
    const overview = state.overview;
    const deptCards = Object.keys(DEPARTMENT_LABELS).map(dept => {
      const closing = state.closings.find(c => c.department === dept);
      return '<div class="card">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span style="font-size:22px">' + DEPARTMENT_ICONS[dept] + '</span><div style="font-weight:700;font-size:14px">' + DEPARTMENT_LABELS[dept] + '</div></div>' +
        (closing
          ? '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">Closed by ' + escapeHtml(closing.closed_by || '—') + '</div>' +
            '<div style="font-weight:800;font-size:20px;color:var(--p);margin-bottom:10px">' + formatMoney(closing.totals.grossTotal || 0) + '</div>' +
            (closing.status === 'reopened' ? badge('Reopened', 'warn') : badge('Closed', 'success')) +
            (closing.status === 'closed' ? '<button class="btn ghost sm" style="margin-left:8px" onclick="window.__reopenEod(\'' + closing.id + '\')">Reopen</button>' : '')
          : '<div style="font-size:12px;color:var(--text3);margin-bottom:10px">Not closed yet.</div>' +
            '<button class="btn primary full" onclick="window.__openCloseDept(\'' + dept + '\')">Close ' + DEPARTMENT_LABELS[dept].split(' ')[0] + '</button>'
        ) +
      '</div>';
    }).join('');

    let usersSection = '';
    if (overview && overview.users && overview.users.length) {
      usersSection =
      '<div class="card" style="padding:22px;margin-top:20px"><h3 style="font-size:16px;margin-bottom:12px">By staff member</h3>' +
        '<div class="table-wrap"><table><thead><tr><th>Staff</th><th>Departments</th><th>Closings</th><th>Recorded</th><th>Status</th></tr></thead><tbody>' +
        overview.users.map(u =>
          '<tr><td style="font-weight:600">' + escapeHtml(u.name) + (u.role ? ' <span style="font-size:10.5px;color:var(--text3)">(' + escapeHtml(u.role.replace('_', ' ')) + ')</span>' : '') + '</td>' +
          '<td>' + u.closings.map(c => DEPARTMENT_LABELS[c.department] ? DEPARTMENT_LABELS[c.department].split(' ')[0] : c.department).join(', ') + '</td>' +
          '<td>' + u.closings.length + '</td>' +
          '<td style="font-weight:700">' + formatMoney(u.total) + '</td>' +
          '<td>' + (u.closings.every(c => c.status === 'closed') ? badge('All closed', 'success') : badge('Has reopened', 'warn')) + '</td></tr>'
        ).join('') +
        '</tbody></table></div>' +
        '<div style="display:flex;justify-content:flex-end;margin-top:12px;font-size:14px;font-weight:800">Grand total: ' + formatMoney(overview.grandTotal) + '</div>' +
      '</div>';
    }

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>End of Day</h1><p>' + fmtDate(state.date) + ' &middot; ' + state.closings.length + ' of ' + Object.keys(DEPARTMENT_LABELS).length + ' departments closed</p></div></div>' +
    '<div style="display:flex;gap:10px;align-items:center;margin-bottom:16px">' +
      '<input type="date" class="form-input" style="max-width:180px" value="' + state.date + '" onchange="window.__eodDateChange(this.value)"/>' +
      '<button class="btn outline sm" onclick="window.__eodDateChange(\'' + new Date().toISOString().slice(0, 10) + '\')">Today</button>' +
    '</div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' +
      metricCard('Closed Today (Recorded Revenue)', formatMoney(closedTotal), null, '🌙') +
    '</div>' +
    '<div class="grid grid-3">' + deptCards + '</div>' +
    usersSection;
  }

  function fmtDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }); }
  window.__eodDateChange = (v) => { state.date = v; load(); };

  window.__openCloseDept = async (dept) => {
    let preview;
    try { preview = await API.get('/api/eod/preview?department=' + dept + '&date=' + state.date); }
    catch (err) { toast(err.message, 'error'); return; }

    const methodRows = Object.entries(preview.byMethod || {}).map(([m, amt]) => '<div class="pos-cart-totals-row"><span>' + escapeHtml(m) + '</span><span>' + formatMoney(amt) + '</span></div>').join('');
    openModal('Close ' + (DEPARTMENT_LABELS[dept] || dept) + ' — ' + state.date,
      '<div class="pos-cart-totals" style="background:var(--surface2);padding:14px;border-radius:var(--radius);margin-bottom:14px">' +
        '<div class="pos-cart-totals-row"><span>Transactions</span><span>' + preview.count + '</span></div>' +
        methodRows +
        '<div class="pos-cart-totals-row grand"><span>Gross Total</span><span>' + formatMoney(preview.grossTotal) + '</span></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Notes (optional)</label><input class="form-input" id="eod-notes" placeholder="Any discrepancies or comments…"/></div>' +
      '<p style="font-size:11px;color:var(--text3)">These totals are computed live from the actual transactions recorded today — nothing is manually entered.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitClose(\'' + dept + '\')">Confirm Close</button>'
    );
  };
  window.__submitClose = async (dept) => {
    try {
      await API.post('/api/eod/close', { department: dept, date: state.date, notes: document.getElementById('eod-notes').value.trim() });
      toast((DEPARTMENT_LABELS[dept] || dept) + ' closed for the day', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__reopenEod = (id) => {
    confirmAction('Reopen this closing? Use this only to correct an error.', async () => {
      try { await API.post('/api/eod/' + id + '/reopen'); toast('Closing reopened', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
