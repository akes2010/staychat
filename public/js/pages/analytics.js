// public/js/pages/analytics.js
window.PAGES = window.PAGES || {};

PAGES.analytics = function () {
  const wrap = el('div', 'fa');
  wrap.innerHTML = loaderHTML('Loading analytics…');

  (async () => {
    try {
      const [summary, depts, engine] = await Promise.all([
        API.get('/api/analytics/summary'),
        API.get('/api/analytics/departments'),
        API.get('/api/analytics/engine'),
      ]);
      wrap.innerHTML = '';
      wrap.appendChild(buildAnalytics(summary, depts, engine));
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'analytics\')'); }
  })();

  return wrap;
};

function buildAnalytics(summary, depts, engine) {
  const root = el('div');
  const history = summary.dailyHistory || [];
  const revVals = history.map(d => d.revenue);
  const occVals = history.map(d => d.occupancyPct);
  const maxR = Math.max(1, ...revVals);
  const maxO = Math.max(1, ...occVals);

  const revBars = history.map((d, i) => '<div class="bar-col"><div class="bar-wrap"><div class="bar" style="height:' + (d.revenue / maxR * 100) + '%;background:' + (i === history.length - 1 ? 'var(--p)' : 'rgba(0,109,47,.3)') + '" title="' + formatMoney(d.revenue) + '"></div></div><span class="bar-label">' + d.date.slice(5) + '</span></div>').join('');
  const occBars = history.map((d, i) => '<div class="bar-col"><div class="bar-wrap"><div class="bar" style="height:' + (d.occupancyPct / maxO * 100) + '%;background:' + (d.occupancyPct === maxO ? 'var(--p)' : '#dae2fd') + '" title="' + d.occupancyPct + '%"></div></div><span class="bar-label">' + d.date.slice(5) + '</span></div>').join('');

  // Booking-engine submissions, last 14 days (zero-filled server-side).
  const engHistory = engine.daily || [];
  const maxE = Math.max(1, ...engHistory.map(d => d.submissions));
  const engineBars = engHistory.map((d, i) => '<div class="bar-col"><div class="bar-wrap"><div class="bar" style="height:' + (d.submissions / maxE * 100) + '%;background:' + (i === engHistory.length - 1 ? 'var(--p)' : '#dae2fd') + '" title="' + d.submissions + ' submitted · ' + d.confirmed + ' confirmed"></div></div><span class="bar-label">' + d.date.slice(5) + '</span></div>').join('');

  const deptCards = (depts.staffByDept || []).map(d => {
    const v = Math.min(100, Math.round((d.avgTasks || 0) * 3));
    return '<div style="background:var(--surface2);border-radius:var(--radius);padding:13px;border:1px solid var(--border)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><span style="font-size:20px">👥</span><span style="font-weight:700;font-size:13px;color:var(--p)">' + v + '%</span></div>' +
      '<div style="font-weight:600;font-size:12px;margin-bottom:2px">' + escapeHtml(d.department || 'Unassigned') + '</div><div style="font-size:11px;color:var(--text3);margin-bottom:8px">' + d.c + ' staff &middot; avg ' + Math.round(d.avgTasks || 0) + ' tasks</div>' + pbar(v, 'var(--a)') + '</div>';
  }).join('');

  root.innerHTML = '' +
  '<div class="page-header"><div class="page-header-left"><h1>Analytics &amp; Reports</h1><p>Business performance and insights</p></div>' +
    '<button class="btn outline" onclick="toast(\'PDF export requires a reporting service — see roadmap\',\'info\')">Export PDF</button></div>' +
  '<div class="grid grid-4" style="margin-bottom:20px">' +
    metricCard('Occupancy Now', summary.occupancyPct + '%', null, '🛏') +
    metricCard('Revenue Today', formatMoney(summary.todayRevenue), null, '💰') +
    metricCard('Orders Today', summary.totalOrdersToday, null, '🍽') +
    metricCard('Maintenance Completion', (depts.maintenanceCompletionRate || 0) + '%', null, '🔧') +
  '</div>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">' +
    '<div class="card"><div class="card-header"><span class="card-title">Revenue — Last 12 Days</span></div><div class="bar-chart">' + (revBars || '<div style="color:var(--text3);font-size:13px">No data yet</div>') + '</div></div>' +
    '<div class="card"><div class="card-header"><span class="card-title">Occupancy — Last 12 Days (%)</span></div><div class="bar-chart">' + (occBars || '<div style="color:var(--text3);font-size:13px">No data yet</div>') + '</div></div>' +
  '</div>' +
  '<div class="card"><div class="card-header"><span class="card-title">Staff by Department</span></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:13px">' + (deptCards || '<div style="color:var(--text3);font-size:13px">No staff records yet</div>') + '</div></div>' +

  // ── Booking engine (public channel) ──
  '<div class="card" style="margin-top:16px"><div class="card-header"><span class="card-title">Booking Engine — Direct Channel</span></div>' +
    '<div class="grid grid-4" style="margin-bottom:16px">' +
      metricCard('Submissions', String(engine.submissions), null, '📥') +
      metricCard('Confirmed', String(engine.confirmed), null, '✅') +
      metricCard('Confirmation Rate', engine.confirmRate === null ? '—' : engine.confirmRate + '%', null, '📈') +
      metricCard('Confirmed Revenue', formatMoney(engine.confirmedRevenue), null, '💰') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text3);margin-bottom:8px">' +
      'Pending: <b>' + engine.pending + '</b> · Rejected: <b>' + engine.rejected + '</b> · Avg booking value: <b>' + formatMoney(engine.avgValue) + '</b>' +
    '</div>' +
    '<div class="bar-chart">' + (engineBars || '<div style="color:var(--text3);font-size:13px">No submissions in the last 14 days</div>') + '</div>' +
  '</div>';

  return root;
}
