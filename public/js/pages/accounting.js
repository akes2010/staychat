// public/js/pages/accounting.js
// Accounting — chart of accounts, double-entry journal, vouchers, ledger,
// trial balance, and cash book. Posting requires accounting.manage; an
// auditor (accounting.view only) sees every tab read-only.
window.PAGES = window.PAGES || {};

PAGES.accounting = function () {
  const wrap = el('div', 'fa');
  const state = { tab: 'trial-balance', accounts: [], journal: [], vouchers: [], trialBalance: null, cashbook: null, ledger: null, creditSales: null };
  const canManage = typeof can === 'function' ? can('accounting.manage') : true;

  async function load() {
    wrap.innerHTML = loaderHTML('Loading accounting…');
    try {
      const [accounts, trialBalance] = await Promise.all([API.get('/api/accounting/accounts'), API.get('/api/accounting/trial-balance')]);
      state.accounts = accounts; state.trialBalance = trialBalance;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'accounting\')'); }
  }

  const TABS = [
    ['trial-balance', 'Trial Balance'], ['ledger', 'Ledger'], ['cashbook', 'Cash Book'],
    ['journal', 'Journal'], ['vouchers', 'Vouchers'], ['credit-sales', 'Credit Sales'], ['accounts', 'Chart of Accounts'],
  ];

  async function switchTab(tab) {
    state.tab = tab;
    try {
      if (tab === 'journal' && state.journal.length === 0) state.journal = await API.get('/api/accounting/journal');
      if (tab === 'vouchers' && state.vouchers.length === 0) state.vouchers = await API.get('/api/accounting/vouchers');
      if (tab === 'cashbook' && !state.cashbook) state.cashbook = await API.get('/api/accounting/cashbook');
      if (tab === 'credit-sales' && !state.creditSales) state.creditSales = await API.get('/api/accounting/credit-sales');
      if (tab === 'trial-balance' && !state.trialBalance) state.trialBalance = await API.get('/api/accounting/trial-balance');
    } catch (err) { toast(err.message, 'error'); }
    render();
  }
  window.__acctTab = switchTab;

  function render() {
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Accounting</h1><p>Double-entry ledger, trial balance, cash book &amp; vouchers</p></div>' +
      (canManage ? '<div style="display:flex;gap:10px"><button class="btn outline" onclick="window.__openJournalEntry()">+ Journal Entry</button><button class="btn primary" onclick="window.__openVoucher()">+ Voucher</button></div>' : '') +
    '</div>' +
    '<div class="filter-pills">' + TABS.map(([id, label]) => '<button class="pill ' + (state.tab === id ? 'active' : '') + '" onclick="window.__acctTab(\'' + id + '\')">' + label + '</button>').join('') + '</div>' +
    '<div id="acct-content">' + renderTab() + '</div>';
  }

  function renderTab() {
    if (state.tab === 'trial-balance') return trialBalanceHTML();
    if (state.tab === 'ledger') return ledgerHTML();
    if (state.tab === 'cashbook') return cashbookHTML();
    if (state.tab === 'journal') return journalHTML();
    if (state.tab === 'vouchers') return vouchersHTML();
    if (state.tab === 'credit-sales') return creditSalesHTML();
    if (state.tab === 'accounts') return accountsHTML();
    return '';
  }

  function trialBalanceHTML() {
    const tb = state.trialBalance;
    if (!tb) return loaderHTML('Loading…');
    return '<div style="margin-bottom:12px;font-size:12px;color:var(--text3)">As of ' + tb.asOf + ' &middot; ' + (tb.balanced ? badge('Balanced', 'success') : badge('Out of Balance', 'error')) + '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Debit</th><th>Credit</th></tr></thead><tbody>' +
      tb.rows.map(r => '<tr><td>' + escapeHtml(r.account.code) + '</td><td>' + escapeHtml(r.account.name) + '</td><td style="font-size:11px;color:var(--text3);text-transform:capitalize">' + r.account.type + '</td>' +
        '<td>' + (r.debit ? formatMoney(r.debit) : '—') + '</td><td>' + (r.credit ? formatMoney(r.credit) : '—') + '</td></tr>').join('') +
      (tb.rows.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text3)">No postings yet</td></tr>' : '') +
      '<tr style="font-weight:800;border-top:2px solid var(--border)"><td colspan="3">Total</td><td>' + formatMoney(tb.totalDebit) + '</td><td>' + formatMoney(tb.totalCredit) + '</td></tr>' +
    '</tbody></table></div>';
  }

  function ledgerHTML() {
    return '<div class="form-group" style="max-width:320px;margin-bottom:14px"><label class="form-label">Select Account</label>' +
      '<select class="form-select" onchange="window.__loadLedger(this.value)"><option value="">— Choose an account —</option>' +
      state.accounts.map(a => '<option value="' + a.id + '">' + escapeHtml(a.code) + ' — ' + escapeHtml(a.name) + '</option>').join('') + '</select></div>' +
      '<div id="ledger-body">' + (state.ledger ? ledgerBodyHTML(state.ledger) : '<div class="empty-state"><div class="empty-state-icon">📒</div><div class="empty-state-title">Pick an account to see its ledger</div></div>') + '</div>';
  }
  function ledgerBodyHTML(l) {
    return '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Memo</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>' +
      l.lines.map(ln => '<tr><td style="font-size:12px">' + ln.date + '</td><td style="font-size:12px">' + escapeHtml(ln.reference || '') + '</td><td style="font-size:12px;color:var(--text3)">' + escapeHtml(ln.memo || ln.description || '') + '</td>' +
        '<td>' + (ln.debit ? formatMoney(ln.debit) : '—') + '</td><td>' + (ln.credit ? formatMoney(ln.credit) : '—') + '</td><td style="font-weight:700">' + formatMoney(ln.runningBalance) + '</td></tr>').join('') +
      (l.lines.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text3)">No postings on this account yet</td></tr>' : '') +
    '</tbody></table></div>' +
    '<div style="margin-top:10px;font-weight:700">Closing Balance: <span style="color:var(--p)">' + formatMoney(l.closingBalance) + '</span></div>';
  }
  window.__loadLedger = async (accountId) => {
    if (!accountId) { state.ledger = null; document.getElementById('ledger-body').innerHTML = ''; return; }
    try { state.ledger = await API.get('/api/accounting/ledger/' + accountId); document.getElementById('ledger-body').innerHTML = ledgerBodyHTML(state.ledger); }
    catch (err) { toast(err.message, 'error'); }
  };

  function cashbookHTML() {
    const cb = state.cashbook;
    if (!cb) return loaderHTML('Loading…');
    return '<div class="table-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>In (Debit)</th><th>Out (Credit)</th><th>Balance</th></tr></thead><tbody>' +
      cb.lines.map(l => '<tr><td style="font-size:12px">' + l.date + '</td><td style="font-size:12px">' + escapeHtml(l.reference || '') + '</td><td style="font-size:12px;color:var(--text3)">' + escapeHtml(l.description || '') + '</td>' +
        '<td>' + (l.debit ? formatMoney(l.debit) : '—') + '</td><td>' + (l.credit ? formatMoney(l.credit) : '—') + '</td><td style="font-weight:700">' + formatMoney(l.runningBalance) + '</td></tr>').join('') +
      (cb.lines.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text3)">No cash movements yet</td></tr>' : '') +
    '</tbody></table></div>' +
    '<div style="margin-top:10px;font-weight:700">Closing Cash Balance: <span style="color:var(--p)">' + formatMoney(cb.closingBalance) + '</span></div>';
  }

  function journalHTML() {
    return '<div style="display:flex;flex-direction:column;gap:10px">' + state.journal.map(e => '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><div><strong>' + escapeHtml(e.description || e.reference || 'Journal Entry') + '</strong> ' + badge(e.source, 'default') + '</div><div style="font-size:12px;color:var(--text3)">' + e.date + '</div></div>' +
      '<table style="width:100%;font-size:12px"><tbody>' + e.lines.map(l => '<tr><td>' + escapeHtml(l.code) + ' — ' + escapeHtml(l.account_name) + '</td><td style="text-align:right">' + (l.debit ? formatMoney(l.debit) : '') + '</td><td style="text-align:right">' + (l.credit ? formatMoney(l.credit) : '') + '</td></tr>').join('') + '</table>' +
    '</div>').join('') + (state.journal.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">📔</div><div class="empty-state-title">No journal entries yet</div></div>' : '') + '</div>';
  }

  function vouchersHTML() {
    return '<div class="table-wrap"><table><thead><tr><th>Voucher #</th><th>Type</th><th>Date</th><th>Narration</th><th>Amount</th></tr></thead><tbody>' +
      state.vouchers.map(v => '<tr><td style="font-weight:600">' + escapeHtml(v.voucher_no) + '</td><td>' + badge(v.type, 'default') + '</td><td style="font-size:12px">' + v.date + '</td><td style="font-size:12px;color:var(--text3)">' + escapeHtml(v.narration || '') + '</td><td style="font-weight:700">' + formatMoney(v.amount) + '</td></tr>').join('') +
      (state.vouchers.length === 0 ? '<tr><td colspan="5" style="text-align:center;color:var(--text3)">No vouchers yet</td></tr>' : '') +
    '</tbody></table></div>';
  }

  function creditSalesHTML() {
    const cs = state.creditSales;
    if (!cs) return loaderHTML('Loading…');
    return '<div class="grid grid-3" style="margin-bottom:16px">' + metricCard('Outstanding Credit Sales', formatMoney(cs.total), cs.count + ' unpaid', '📇') + '</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Guest / Customer</th><th>Room</th><th>Description</th><th>Method</th><th>Amount</th><th>Date</th></tr></thead><tbody>' +
      cs.transactions.map(t => '<tr><td>' + escapeHtml(t.guest_name) + '</td><td>' + (t.room_number || '—') + '</td><td style="font-size:12px;color:var(--text3)">' + escapeHtml(t.description || '') + '</td><td>' + badge(t.method, 'warn') + '</td><td style="font-weight:700">' + formatMoney(t.amount) + '</td><td style="font-size:12px">' + timeAgo(t.created_at) + '</td></tr>').join('') +
      (cs.transactions.length === 0 ? '<tr><td colspan="6" style="text-align:center;color:var(--text3)">No outstanding credit sales</td></tr>' : '') +
    '</tbody></table></div>';
  }

  function accountsHTML() {
    return '<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Normal Balance</th><th>Status</th></tr></thead><tbody>' +
      state.accounts.map(a => '<tr><td>' + escapeHtml(a.code) + '</td><td>' + escapeHtml(a.name) + '</td><td style="text-transform:capitalize">' + a.type + '</td><td style="text-transform:capitalize">' + a.normal_balance + '</td><td>' + (a.active ? badge('Active', 'success') : badge('Inactive', 'default')) + '</td></tr>').join('') +
    '</tbody></table></div>' +
    (canManage ? '<button class="btn outline" style="margin-top:14px" onclick="window.__openAccount()">+ Add Account</button>' : '');
  }

  // ── Add account ──────────────────────────────────────────────────────
  window.__openAccount = () => {
    openModal('Add Account',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Code</label><input class="form-input" id="acc-code" placeholder="e.g. 6000"/></div>' +
        '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="acc-name" placeholder="e.g. Utilities Expense"/></div>' +
        '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="acc-type"><option value="asset">Asset</option><option value="liability">Liability</option><option value="equity">Equity</option><option value="income">Income</option><option value="expense">Expense</option></select></div>' +
        '<div class="form-group"><label class="form-label">Normal Balance</label><select class="form-select" id="acc-normal"><option value="debit">Debit</option><option value="credit">Credit</option></select></div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addAccount()">Add Account</button>'
    );
  };
  window.__addAccount = async () => {
    try {
      await API.post('/api/accounting/accounts', { code: document.getElementById('acc-code').value.trim(), name: document.getElementById('acc-name').value.trim(), type: document.getElementById('acc-type').value, normalBalance: document.getElementById('acc-normal').value });
      toast('Account added', 'success'); closeModal(); state.accounts = await API.get('/api/accounting/accounts'); render();
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Manual journal entry ─────────────────────────────────────────────
  window.__openJournalEntry = () => {
    openModal('New Journal Entry',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="je-date" value="' + new Date().toISOString().slice(0, 10) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Reference</label><input class="form-input" id="je-ref" placeholder="Optional"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Description</label><input class="form-input" id="je-desc" placeholder="What is this entry for?"/></div>' +
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Debit Account</label><select class="form-select" id="je-debit-acc">' + state.accounts.map(a => '<option value="' + a.id + '">' + escapeHtml(a.code) + ' — ' + escapeHtml(a.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Debit Amount</label><input class="form-input" type="number" min="0" id="je-debit-amt"/></div>' +
        '<div class="form-group"><label class="form-label">Credit Account</label><select class="form-select" id="je-credit-acc">' + state.accounts.map(a => '<option value="' + a.id + '">' + escapeHtml(a.code) + ' — ' + escapeHtml(a.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Credit Amount</label><input class="form-input" type="number" min="0" id="je-credit-amt"/></div>' +
      '</div>' +
      '<p style="font-size:11px;color:var(--text3)">Debit and credit amounts must be equal — this is a simple two-line entry. Use vouchers for common cash/receipt transactions instead.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitJournalEntry()">Post Entry</button>'
    );
  };
  window.__submitJournalEntry = async () => {
    const debitAmt = Number(document.getElementById('je-debit-amt').value || 0);
    const creditAmt = Number(document.getElementById('je-credit-amt').value || 0);
    if (debitAmt !== creditAmt || debitAmt <= 0) { toast('Debit and credit amounts must match and be greater than zero', 'error'); return; }
    try {
      await API.post('/api/accounting/journal', {
        date: document.getElementById('je-date').value, reference: document.getElementById('je-ref').value.trim(), description: document.getElementById('je-desc').value.trim(),
        lines: [{ accountId: document.getElementById('je-debit-acc').value, debit: debitAmt }, { accountId: document.getElementById('je-credit-acc').value, credit: creditAmt }],
      });
      toast('Journal entry posted', 'success'); closeModal(); state.journal = await API.get('/api/accounting/journal'); switchTab('journal');
    } catch (err) { toast(err.message, 'error'); }
  };

  // ── Voucher ──────────────────────────────────────────────────────────
  window.__openVoucher = () => {
    openModal('New Voucher',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="vo-type"><option value="payment">Payment</option><option value="receipt">Receipt</option><option value="journal">Journal</option><option value="contra">Contra</option></select></div>' +
        '<div class="form-group"><label class="form-label">Date</label><input class="form-input" type="date" id="vo-date" value="' + new Date().toISOString().slice(0, 10) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Debit Account</label><select class="form-select" id="vo-debit">' + state.accounts.map(a => '<option value="' + a.id + '">' + escapeHtml(a.code) + ' — ' + escapeHtml(a.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Credit Account</label><select class="form-select" id="vo-credit">' + state.accounts.map(a => '<option value="' + a.id + '">' + escapeHtml(a.code) + ' — ' + escapeHtml(a.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Amount</label><input class="form-input" type="number" min="0" id="vo-amount"/></div>' +
      '</div>' +
      '<div class="form-group"><label class="form-label">Narration</label><input class="form-input" id="vo-narration" placeholder="What is this voucher for?"/></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__submitVoucher()">Post Voucher</button>'
    );
  };
  window.__submitVoucher = async () => {
    const amount = Number(document.getElementById('vo-amount').value || 0);
    if (amount <= 0) { toast('Amount must be greater than zero', 'error'); return; }
    try {
      await API.post('/api/accounting/vouchers', {
        type: document.getElementById('vo-type').value, date: document.getElementById('vo-date').value, amount,
        debitAccountId: document.getElementById('vo-debit').value, creditAccountId: document.getElementById('vo-credit').value,
        narration: document.getElementById('vo-narration').value.trim(),
      });
      toast('Voucher posted', 'success'); closeModal(); state.vouchers = await API.get('/api/accounting/vouchers'); switchTab('vouchers');
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
