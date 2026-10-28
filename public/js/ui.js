// public/js/ui.js
// Shared DOM helpers, toast/modal system, and small reusable component renderers.
// All page modules (public/js/pages/*.js) depend on these globals.

function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }

function toast(msg, type, dur) {
  type = type || 'success'; dur = dur || 3500;
  const area = document.getElementById('toast-area');
  const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' };
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = '<span class="toast-ico">' + (icons[type] || '•') + '</span><span class="toast-msg">' + escapeHtml(msg) + '</span><button class="toast-close" onclick="this.parentElement.remove()">✕</button>';
  area.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, dur);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/**
 * Escape a value that is being interpolated into a JavaScript string literal that
 * itself sits inside an HTML attribute — e.g. onclick="doThing('HERE')".
 *
 * escapeHtml() is WRONG for that position and actively dangerous there: it turns
 * ' into &#39;, the browser HTML-decodes the attribute back to ' before the JS
 * parser ever sees it, and the value breaks straight out of the string literal.
 * A guest whose WhatsApp profile name is  '+alert(1)+'  therefore ran script in a
 * logged-in staff member's browser, and the app ships with CSP disabled so there
 * was no second line of defence.
 *
 * Here we neutralise the JS layer first (backslash-escaping quotes, backslashes and
 * line terminators) and only then the HTML layer, so the value survives both
 * decoders as inert text.
 */
function escapeJsInAttr(str) {
  if (str === null || str === undefined) return '';
  const js = String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return escapeHtml(js);
}

function openModal(title, bodyHTML, footerHTML, opts) {
  opts = opts || {};
  const c = document.getElementById('modal-container');
  const wide = opts.wide ? 'wide' : '';
  c.innerHTML = '<div class="overlay" id="modal-overlay" onclick="closeModalOnBg(event)">' +
    '<div class="modal ' + wide + '" id="modal">' +
      '<div class="modal-header">' +
        '<div><div class="modal-title">' + title + '</div>' + (opts.sub ? '<div class="modal-sub">' + opts.sub + '</div>' : '') + '</div>' +
        '<button class="modal-close" onclick="closeModal()">✕</button>' +
      '</div>' +
      '<div class="modal-body">' + bodyHTML + '</div>' +
      (footerHTML ? '<div class="modal-footer">' + footerHTML + '</div>' : '') +
    '</div>' +
  '</div>';
}
function closeModal() { document.getElementById('modal-container').innerHTML = ''; }
function closeModalOnBg(e) { if (e.target.id === 'modal-overlay') closeModal(); }

function confirmAction(msg, onYes) {
  openModal('Confirm Action', '<p style="font-size:14px;color:var(--text2)">' + escapeHtml(msg) + '</p>',
    '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn danger" id="confirm-yes-btn">Confirm</button>');
  document.getElementById('confirm-yes-btn').onclick = function () { onYes(); closeModal(); };
}

function badge(label, type) { return '<span class="badge ' + (type || 'default') + '">' + escapeHtml(label) + '</span>'; }

function statusBadge(status) {
  const map = {
    available: ['Available','success'], occupied: ['Occupied','info'], dirty: ['Dirty','warn'],
    maintenance: ['Maintenance','error'], cleaning: ['Cleaning','dark'], pending: ['Pending','warn'],
    'in-progress': ['In Progress','info'], completed: ['Done','success'], delivered: ['Delivered','success'],
    preparing: ['Preparing','info'], cancelled: ['Cancelled','error'], active: ['Active','success'],
    break: ['On Break','warn'], busy: ['Busy','error'], 'off-duty': ['Off Duty','default'],
    trial: ['Trial','warn'], suspended: ['Suspended','error'], failed: ['Failed','error'], refunded: ['Refunded','default'],
    confirmed: ['Confirmed','info'], checked_in: ['Checked In','success'], checked_out: ['Checked Out','default'],
    tentative: ['Tentative','warn'], no_show: ['No Show','error'], open: ['Open','info'], closed: ['Closed','default'],
    void: ['Void','error'],
  };
  const pair = map[status] || [status, 'default'];
  return badge(pair[0], pair[1]);
}

function pbar(pct, color) { return '<div class="pbar-wrap"><div class="pbar" style="width:' + pct + '%;background:' + (color || 'var(--a)') + '"></div></div>'; }

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function dateNow() { return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
function timeNow() { return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); }

function metricCard(label, value, sub, ico, deltaClass) {
  return '<div class="metric-card">' +
    '<div class="metric-top"><div class="metric-icon" style="background:var(--surface2)">' + ico + '</div>' +
    (sub ? '<span class="metric-delta ' + (deltaClass || 'up') + '">' + escapeHtml(sub) + '</span>' : '') + '</div>' +
    '<div class="metric-label">' + escapeHtml(label) + '</div>' +
    '<div class="metric-value">' + value + '</div>' +
  '</div>';
}

function loaderHTML(msg) {
  return '<div class="page-loader"><span class="spin" style="display:inline-block">⏳</span> ' + escapeHtml(msg || 'Loading…') + '</div>';
}

function errorStateHTML(msg, retryFn) {
  return '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">Something went wrong</div>' +
    '<div class="empty-state-desc">' + escapeHtml(msg) + '</div>' +
    (retryFn ? '<button class="btn outline" style="margin-top:14px" onclick="' + retryFn + '">Retry</button>' : '') + '</div>';
}

// Generic "render this page, handle loading + error" wrapper used by every page module.
async function renderAsync(container, loadFn, renderFn, retryGlobalName) {
  container.innerHTML = loaderHTML('Loading…');
  try {
    const data = await loadFn();
    container.innerHTML = '';
    container.appendChild(renderFn(data));
  } catch (err) {
    console.error(err);
    container.innerHTML = errorStateHTML(err.message || 'Failed to load data', retryGlobalName ? retryGlobalName + '()' : null);
  }
}

function formatMoney(amount, currency) {
  currency = currency || (window.App && App.tenant && App.tenant.currency) || '$';
  const n = Number(amount || 0);
  return currency + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Receipt printing ─────────────────────────────────────────────────────
// Opens a correctly-sized browser print window for a receipt. widthMM should
// be '80mm' / '58mm' for a thermal printer, or '210mm' for an A4 printer.
// Everything prints HEAVY and pure black — thin/normal weights come off the
// thermal head (and off laser drafts) as faint grey that staff can't read.
function printReceiptWindow(receipt, widthMM) {
  widthMM = widthMM || '80mm';
  const isThermal = widthMM !== '210mm';
  const inkWeight = isThermal ? '700' : '600';
  const win = window.open('', '_blank', 'width=480,height=720');
  const rows = (receipt.lines || []).map(l =>
    '<div class="row"><span class="desc">' + escapeHtml(l[0]) + '</span><span>' + escapeHtml(String(l[1] || '')) + '</span><span class="amt">' + escapeHtml(l[2] || '') + '</span></div>'
  ).join('');
  const totals = (receipt.totals || []).map(t =>
    '<div class="row' + (t[2] ? ' grand' : '') + '"><span class="desc">' + escapeHtml(t[0]) + '</span><span></span><span class="amt">' + escapeHtml(t[1]) + '</span></div>'
  ).join('');
  const meta = (receipt.meta || []).map(m => '<div class="row"><span class="desc">' + escapeHtml(m[0]) + '</span><span></span><span class="amt">' + escapeHtml(m[1]) + '</span></div>').join('');

  win.document.write('<html><head><title>' + escapeHtml(receipt.title || 'Receipt') + '</title><style>' +
    '@page { size: ' + widthMM + ' auto; margin: 3mm; } * { box-sizing: border-box; }' +
    'body { font-family: ' + (isThermal ? "'Courier New', monospace" : "Arial, sans-serif") + '; width: ' + widthMM + '; margin: 0 auto; font-size: ' + (isThermal ? '11px' : '13px') + '; color: #000; font-weight: ' + inkWeight + '; -webkit-print-color-adjust: exact; print-color-adjust: exact; }' +
    '.center { text-align: center; } .bold { font-weight: 700; } .line { border-top: 1px dashed #000; margin: 6px 0; }' +
    '.row { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; } .row .desc { flex: 2; } .row .amt { flex: 1; text-align: right; white-space: nowrap; }' +
    '.row.grand { font-weight: 800; font-size: ' + (isThermal ? '13px' : '15px') + '; border-top: 1px solid #000; margin-top: 4px; padding-top: 4px; }' +
    '.hotelname { font-size: ' + (isThermal ? '14px' : '18px') + '; font-weight: 800; }' +
    '.footer { margin-top: 10px; font-size: ' + (isThermal ? '10px' : '11px') + '; }' +
  '</style></head><body>' +
    '<div class="center hotelname">' + escapeHtml(receipt.hotelName || 'Hotel') + '</div>' +
    (receipt.subtitle ? '<div class="center">' + escapeHtml(receipt.subtitle) + '</div>' : '') +
    '<div class="center bold" style="margin-top:6px">' + escapeHtml(receipt.title || 'RECEIPT') + '</div>' +
    '<div class="line"></div>' +
    meta +
    (rows ? '<div class="line"></div>' + rows : '') +
    '<div class="line"></div>' +
    totals +
    '<div class="line"></div>' +
    '<div class="center footer">' + (receipt.footer || 'Thank you for your business!') + '</div>' +
  '</body></html>');
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

// Shows an in-app preview modal with a Print button, then calls printReceiptWindow.
function showReceiptPopup(receipt) {
  const previewRows = (receipt.lines || []).map(l => '<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0"><span>' + escapeHtml(l[0]) + (l[1] ? ' ×' + escapeHtml(String(l[1])) : '') + '</span><span>' + escapeHtml(l[2] || '') + '</span></div>').join('');
  const previewTotals = (receipt.totals || []).map(t => '<div style="display:flex;justify-content:space-between;font-size:' + (t[2] ? '15px' : '13px') + ';font-weight:' + (t[2] ? '800' : '600') + ';padding:2px 0"><span>' + escapeHtml(t[0]) + '</span><span>' + escapeHtml(t[1]) + '</span></div>').join('');
  const previewMeta = (receipt.meta || []).map(m => '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);padding:1px 0"><span>' + escapeHtml(m[0]) + '</span><span>' + escapeHtml(m[1]) + '</span></div>').join('');

  window.__pendingReceipt = receipt;
  openModal('✅ ' + escapeHtml(receipt.title || 'Payment Successful'),
    '<div style="background:var(--surface2);border-radius:var(--radius);padding:16px;font-family:monospace">' +
      '<div style="text-align:center;font-weight:800;font-size:15px">' + escapeHtml(receipt.hotelName || '') + '</div>' +
      (receipt.subtitle ? '<div style="text-align:center;font-size:11px;color:var(--text3)">' + escapeHtml(receipt.subtitle) + '</div>' : '') +
      '<div style="border-top:1px dashed var(--border-dark);margin:8px 0"></div>' +
      previewMeta +
      (previewRows ? '<div style="border-top:1px dashed var(--border-dark);margin:8px 0"></div>' + previewRows : '') +
      '<div style="border-top:1px dashed var(--border-dark);margin:8px 0"></div>' +
      previewTotals +
    '</div>' +
    '<div class="form-group" style="margin-top:14px"><label class="form-label">Print For</label>' +
      '<select class="form-select" id="receipt-paper">' +
        '<option value="80mm"' + (receipt.defaultPaper === '80mm' ? ' selected' : '') + '>Thermal 80mm</option>' +
        '<option value="58mm"' + (receipt.defaultPaper === '58mm' ? ' selected' : '') + '>Thermal 58mm</option>' +
        '<option value="210mm"' + (receipt.defaultPaper === '210mm' ? ' selected' : '') + '>A4 (Front Desk)</option>' +
      '</select></div>',
    '<button class="btn outline" onclick="closeModal()">Close</button><button class="btn primary" onclick="window.__printPendingReceipt()">🖨️ Print Receipt</button>'
  );
}
window.__printPendingReceipt = function () {
  const paper = document.getElementById('receipt-paper').value;
  printReceiptWindow(window.__pendingReceipt, paper);
};
