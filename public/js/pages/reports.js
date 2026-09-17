// public/js/pages/reports.js
// Report Management — pick a module, pick a period (daily/weekly/monthly/
// quarterly/yearly/custom), see that module's activity for the period as a
// table plus a quick summary. Every report is generated live from real data.
window.PAGES = window.PAGES || {};

PAGES.reports = function () {
  const wrap = el('div', 'fa');
  const state = { types: [], type: 'transactions', period: 'daily', date: new Date().toISOString().slice(0, 10), from: '', to: '', data: null };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading report management…');
    try { state.types = await API.get('/api/reports/types'); await runReport(); }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'reports\')'); }
  }

  async function runReport() {
    const params = new URLSearchParams({ period: state.period });
    if (state.period === 'custom') { params.set('from', state.from || state.date); params.set('to', state.to || state.date); }
    else params.set('date', state.date);
    try { state.data = await API.get('/api/reports/' + state.type + '?' + params.toString()); render(); }
    catch (err) { toast(err.message, 'error'); }
  }

  window.__reportSetType = (t) => { state.type = t; runReport(); };
  window.__reportSetPeriod = (p) => { state.period = p; runReport(); };
  window.__reportSetDate = (v) => { state.date = v; runReport(); };
  window.__reportSetCustom = () => {
    state.from = document.getElementById('rep-from').value; state.to = document.getElementById('rep-to').value;
    if (state.from && state.to) runReport();
  };

  function render() {
    const byCategory = {};
    state.types.forEach(t => { (byCategory[t.category] = byCategory[t.category] || []).push(t); });
    const d = state.data;

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Report Management</h1><p>Daily, weekly, monthly, quarterly &amp; yearly reports across every module</p></div></div>' +
    '<div style="display:grid;grid-template-columns:240px 1fr;gap:16px;align-items:start">' +
      '<div class="card" style="padding:12px">' +
        Object.keys(byCategory).map(cat => '<div style="margin-bottom:12px"><div style="font-size:10px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;padding:0 6px">' + cat + '</div>' +
          byCategory[cat].map(t => '<div onclick="window.__reportSetType(\'' + t.id + '\')" style="padding:8px 10px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:600;' + (state.type === t.id ? 'background:var(--p);color:#fff' : 'color:var(--text2)') + '">' + t.label + '</div>').join('') +
        '</div>').join('') +
      '</div>' +
      '<div>' +
        '<div class="card" style="margin-bottom:16px">' +
          '<div class="filter-pills" style="margin-bottom:10px">' +
            ['daily','weekly','monthly','quarterly','yearly','custom'].map(p => '<button class="pill ' + (state.period === p ? 'active' : '') + '" onclick="window.__reportSetPeriod(\'' + p + '\')">' + p.charAt(0).toUpperCase() + p.slice(1) + '</button>').join('') +
          '</div>' +
          (state.period === 'custom'
            ? '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input type="date" class="form-input" id="rep-from" style="max-width:170px" value="' + (state.from || state.date) + '"/><span style="color:var(--text3)">to</span><input type="date" class="form-input" id="rep-to" style="max-width:170px" value="' + (state.to || state.date) + '"/><button class="btn outline sm" onclick="window.__reportSetCustom()">Apply</button></div>'
            : '<input type="date" class="form-input" style="max-width:200px" value="' + state.date + '" onchange="window.__reportSetDate(this.value)"/>') +
          (d ? '<div style="font-size:11px;color:var(--text3);margin-top:8px">Range: ' + d.range.from + ' → ' + d.range.to + '</div>' : '') +
        '</div>' +
        (d ? reportBodyHTML(d) : loaderHTML('Generating report…')) +
      '</div>' +
    '</div>';
  }

  function reportBodyHTML(d) {
    // The generic total/amount/discount name-match works for every report
    // EXCEPT "rooms" (Room Occupancy), whose summary is all counts (total
    // room count, available, occupied, dirty, maintenance) — none of it is
    // money, even though the key is literally called "total".
    const summaryCards = Object.entries(d.summary || {}).map(([k, v]) => {
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
      const isMoney = d.type !== 'rooms' && /total|amount|discount/i.test(k) && typeof v === 'number';
      return metricCard(label, isMoney ? formatMoney(v) : String(v), null, '📊');
    }).join('');

    return '<div class="grid grid-4" style="margin-bottom:16px">' + summaryCards + '</div>' +
      (d.rows.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">📭</div><div class="empty-state-title">No activity in this period</div></div>' : tableForType(d));
  }

  function tableForType(d) {
    const rows = d.rows;
    const cols = columnsForType(d.type);
    return '<div class="table-wrap"><table><thead><tr>' + cols.map(c => '<th>' + c.label + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + cols.map(c => '<td' + (c.money ? ' style="font-weight:700"' : '') + '>' + c.render(r) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>' +
    '<div style="margin-top:10px;font-size:11px;color:var(--text3)">' + rows.length + ' record(s)</div>';
  }

  function safeDate(v) { return v ? String(v).slice(0, 19).replace('T', ' ') : '—'; }
  function money(v) { return formatMoney(v || 0); }
  function esc(v) { return escapeHtml(v === null || v === undefined ? '—' : String(v)); }

  function columnsForType(type) {
    const generic = [
      { label: 'Date', render: r => esc(safeDate(r.created_at)) },
    ];
    const defs = {
      transactions: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Room', render: r => esc(r.room_number) }, { label: 'Description', render: r => esc(r.description) }, { label: 'Method', render: r => esc(r.method) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Amount', money: true, render: r => money(r.amount) }],
      charges: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Room', render: r => esc(r.room_number) }, { label: 'Method', render: r => esc(r.method) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Amount', money: true, render: r => money(r.amount) }],
      discounts: [{ label: 'Closed', render: r => esc(safeDate(r.closed_at)) }, { label: 'Outlet', render: r => esc(r.outlet) }, { label: 'Ticket', render: r => esc(r.label) }, { label: 'Discount %', render: r => (r.discount_pct || 0) + '%' }, { label: 'Discount Amount', money: true, render: r => money(r.discountAmount) }],
      purchasing: [{ label: 'Date', render: r => esc(r.date) }, { label: 'Account', render: r => esc(r.code + ' — ' + r.account_name) }, { label: 'Description', render: r => esc(r.description) }, { label: 'Amount', money: true, render: r => money(r.debit) }],
      walkins: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Reference', render: r => esc(r.reference) }, { label: 'Total', money: true, render: r => money(r.total_amount) }],
      bookings: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Reference', render: r => esc(r.reference) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Group?', render: r => r.is_group ? 'Yes' : 'No' }, { label: 'Total', money: true, render: r => money(r.total_amount) }],
      receptionist: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Staff', render: r => esc(r.user_name) }, { label: 'Action', render: r => esc(r.action) }, { label: 'Entity', render: r => esc(r.entity_type) }, { label: 'Details', render: r => detailsSummary(r.details) }],
      rooms: [{ label: 'Room', render: r => esc(r.number) }, { label: 'Type', render: r => esc(r.type) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Rate', money: true, render: r => money(r.rate) }, { label: 'Stays in Period', render: r => r.staysInPeriod }],
      floors: [{ label: 'Floor', render: r => esc(r.name) }, { label: 'Number', render: r => r.number }, { label: 'Rooms', render: r => r.roomCount }, { label: 'Occupied', render: r => r.occupied }],
      categories: [{ label: 'Category', render: r => esc(r.name) }, { label: 'Weekday', money: true, render: r => money(r.weekday_rate) }, { label: 'Weekend', money: true, render: r => money(r.weekend_rate) }, { label: 'Holiday', money: true, render: r => money(r.holiday_rate) }, { label: 'Festive', money: true, render: r => money(r.festive_rate) }, { label: 'Rooms', render: r => r.roomCount }],
      housekeeping: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Staff', render: r => esc(r.user_name) }, { label: 'Details', render: r => esc(r.details) }],
      maintenance: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Room', render: r => esc(r.room_number) }, { label: 'Issue', render: r => esc(r.issue) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Priority', render: r => esc(r.priority) }],
      restaurant: [{ label: 'Closed', render: r => esc(safeDate(r.closed_at)) }, { label: 'Ticket', render: r => esc(r.label) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Method', render: r => esc(r.payment_method) }, { label: 'Total', money: true, render: r => money(r.total) }],
      bar: [{ label: 'Closed', render: r => esc(safeDate(r.closed_at)) }, { label: 'Ticket', render: r => esc(r.label) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Method', render: r => esc(r.payment_method) }, { label: 'Total', money: true, render: r => money(r.total) }],
      room_service: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Room', render: r => esc(r.room_number) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Total', money: true, render: r => money(r.total) }],
      pool: [{ label: 'Date', render: r => esc(r.date) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Area', render: r => esc(r.area) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Price', money: true, render: r => money(r.price) }],
      hall: [{ label: 'Date', render: r => esc(r.event_date) }, { label: 'Event', render: r => esc(r.event_name) }, { label: 'Organizer', render: r => esc(r.organizer_name) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Total', money: true, render: r => money(r.total_amount) }],
      other_services: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'Service', render: r => esc(r.service_name) }, { label: 'Guest', render: r => esc(r.guest_name) }, { label: 'Status', render: r => statusBadge(r.status) }, { label: 'Total', money: true, render: r => money(r.total) }],
      activity: [{ label: 'Date', render: r => esc(safeDate(r.created_at)) }, { label: 'User', render: r => esc(r.user_name) }, { label: 'Role', render: r => esc(r.user_role) }, { label: 'Action', render: r => esc(r.action) }, { label: 'Entity', render: r => esc(r.entity_type) }],
    };
    return defs[type] || generic;
  }

  load();
  return wrap;
};
