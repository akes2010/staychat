// server/routes/accounting.js
// Double-entry accounting: chart of accounts, journal entries/lines, vouchers,
// ledger, trial balance, and cash book reports. `accounting.manage` can post
// entries/vouchers; `accounting.view` (e.g. an auditor) can only read reports —
// enforced by never granting auditors any `.manage` capability, and by every
// mutating route below explicitly requiring `accounting.manage`.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('accounting.view'), requireEntitlement('accounting'));

const DEFAULT_ACCOUNTS = [
  ['1000', 'Cash on Hand', 'asset', 'debit', 'cash'],
  ['1010', 'Bank Account', 'asset', 'debit', 'bank'],
  ['1100', 'Accounts Receivable — Rooms', 'asset', 'debit', 'ar_room'],
  ['1110', 'Accounts Receivable — Customers', 'asset', 'debit', 'ar_customer'],
  ['1120', 'Accounts Receivable — Group Accounts', 'asset', 'debit', 'ar_group'],
  ['2000', 'Guest Deposits / Advances', 'liability', 'credit', 'guest_deposits'],
  ['3000', "Owner's Equity", 'equity', 'credit', 'equity'],
  ['4000', 'Room Revenue', 'income', 'credit', 'room_revenue'],
  ['4100', 'Restaurant Revenue', 'income', 'credit', 'restaurant_revenue'],
  ['4200', 'Bar Revenue', 'income', 'credit', 'bar_revenue'],
  ['4300', 'Pool Revenue', 'income', 'credit', 'pool_revenue'],
  ['4400', 'Hall / Event Revenue', 'income', 'credit', 'hall_revenue'],
  ['4500', 'Misc. Service Revenue', 'income', 'credit', 'misc_revenue'],
  ['5000', 'Cost of Goods Sold', 'expense', 'debit', 'cogs'],
  ['5100', 'Operating Expenses', 'expense', 'debit', 'operating_expense'],
];

function ensureDefaultAccounts(tenantId) {
  const count = db.prepare('SELECT COUNT(*) c FROM accounts WHERE tenant_id = ?').get(tenantId).c;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO accounts (id, tenant_id, code, name, type, normal_balance, system_key) VALUES (?,?,?,?,?,?,?)');
  DEFAULT_ACCOUNTS.forEach(([code, name, type, normal, key]) => insert.run('acct_' + nanoid(10), tenantId, code, name, type, normal, key));
}

function getAccountByKey(tenantId, systemKey) {
  return db.prepare('SELECT * FROM accounts WHERE tenant_id = ? AND system_key = ?').get(tenantId, systemKey);
}

/**
 * Post a balanced double-entry journal entry.
 * lines: [{ accountId, debit, credit, memo }]  — sum(debit) must equal sum(credit).
 */
function postEntry(tenantId, { date, reference, description, source, sourceId, createdBy, lines }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('A journal entry needs at least 2 lines');
  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  if (!Number.isFinite(totalDebit) || !Number.isFinite(totalCredit)) throw new Error('Journal amounts must be numbers');
  if (Math.abs(totalDebit - totalCredit) > 0.005) throw new Error('Journal entry is not balanced (debit ' + totalDebit + ' vs credit ' + totalCredit + ')');

  // The header and its lines must land together or not at all. Unwrapped, a bad
  // account_id on the third line (journal_lines.account_id is ON DELETE RESTRICT,
  // so a stale id throws) left the header plus the first two lines committed —
  // a permanently unbalanced entry that no report could reconcile and nothing
  // would ever flag, because every caller wraps postEntry in a swallowing
  // try/catch so an accounting failure can't block a sale.
  const entryId = 'je_' + nanoid(10);
  const write = db.transaction(() => {
    db.prepare('INSERT INTO journal_entries (id, tenant_id, date, reference, description, source, source_id, created_by) VALUES (?,?,?,?,?,?,?,?)')
      .run(entryId, tenantId, date, reference || null, description || null, source || 'manual', sourceId || null, createdBy || null);

    const insertLine = db.prepare('INSERT INTO journal_lines (id, tenant_id, entry_id, account_id, debit, credit, memo) VALUES (?,?,?,?,?,?,?)');
    lines.forEach(l => insertLine.run('jl_' + nanoid(10), tenantId, entryId, l.accountId, Number(l.debit) || 0, Number(l.credit) || 0, l.memo || null));
  });
  write();

  return db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(entryId);
}

module.exports = router;
module.exports.postEntry = postEntry;
module.exports.getAccountByKey = getAccountByKey;
module.exports.ensureDefaultAccounts = ensureDefaultAccounts;

// ── Chart of Accounts ────────────────────────────────────────────────
router.get('/accounts', (req, res) => {
  ensureDefaultAccounts(req.tenantId);
  res.json(db.prepare('SELECT * FROM accounts WHERE tenant_id = ? ORDER BY code').all(req.tenantId).map(a => ({ ...a, active: !!a.active })));
});

router.post('/accounts', requirePermission('accounting.manage'), (req, res) => {
  const { code, name, type, normalBalance } = req.body;
  if (!code || !name || !type || !normalBalance) return res.status(400).json({ error: 'code, name, type and normalBalance are required' });
  const id = 'acct_' + nanoid(10);
  try {
    db.prepare('INSERT INTO accounts (id, tenant_id, code, name, type, normal_balance) VALUES (?,?,?,?,?,?)').run(id, req.tenantId, code, name, type, normalBalance);
  } catch (e) { return res.status(409).json({ error: 'An account with this code already exists' }); }
  audit(req, 'accounting.account_create', 'account', id, { code, name });
  res.status(201).json(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
});

// ── Journal Entries (manual) ───────────────────────────────────────────
router.get('/journal', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM journal_entries WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  sql += ' ORDER BY date DESC, created_at DESC LIMIT 500';
  const entries = db.prepare(sql).all(...params);
  const withLines = entries.map(e => ({ ...e, lines: db.prepare('SELECT jl.*, a.code, a.name as account_name FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id WHERE jl.entry_id = ?').all(e.id) }));
  res.json(withLines);
});

router.post('/journal', requirePermission('accounting.manage'), (req, res) => {
  const { date, reference, description, lines } = req.body;
  if (!date || !Array.isArray(lines) || lines.length < 2) return res.status(400).json({ error: 'date and at least 2 journal lines are required' });
  try {
    const entry = postEntry(req.tenantId, { date, reference, description, source: 'manual', createdBy: req.user.name, lines });
    audit(req, 'accounting.journal_post', 'journal_entry', entry.id, { reference });
    res.status(201).json(entry);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ── Vouchers (payment / receipt / journal / contra) ─────────────────────
router.get('/vouchers', (req, res) => {
  res.json(db.prepare('SELECT * FROM vouchers WHERE tenant_id = ? ORDER BY date DESC, created_at DESC LIMIT 500').all(req.tenantId));
});

router.post('/vouchers', requirePermission('accounting.manage'), (req, res) => {
  const { type, date, narration, amount, debitAccountId, creditAccountId } = req.body;
  if (!type || !date || !amount || !debitAccountId || !creditAccountId) {
    return res.status(400).json({ error: 'type, date, amount, debitAccountId and creditAccountId are required' });
  }
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
  const debitAccount = db.prepare('SELECT id FROM accounts WHERE id = ? AND tenant_id = ?').get(debitAccountId, req.tenantId);
  const creditAccount = db.prepare('SELECT id FROM accounts WHERE id = ? AND tenant_id = ?').get(creditAccountId, req.tenantId);
  if (!debitAccount || !creditAccount) return res.status(404).json({ error: 'Debit or credit account not found in this hotel\'s chart of accounts' });
  ensureDefaultAccounts(req.tenantId);

  // Voucher numbers were derived from COUNT(*), so two vouchers created in the same
  // moment both computed the same next number: one insert hit the UNIQUE constraint
  // and threw AFTER postEntry had already committed its journal entry, leaving an
  // orphan entry in the books with no voucher. Numbering and both writes now happen
  // in one transaction, and the number is taken from the highest existing one.
  const id = 'vch_' + nanoid(10);
  let voucherNo;
  try {
    db.transaction(() => {
      const prefix = type.slice(0, 2).toUpperCase() + '-';
      const last = db.prepare(
        `SELECT voucher_no FROM vouchers WHERE tenant_id = ? AND voucher_no LIKE ? ORDER BY voucher_no DESC LIMIT 1`
      ).get(req.tenantId, prefix + '%');
      const next = last ? (parseInt(String(last.voucher_no).slice(prefix.length), 10) || 0) + 1 : 1;
      voucherNo = prefix + String(next).padStart(5, '0');

      const entry = postEntry(req.tenantId, {
        date, reference: voucherNo, description: narration, source: 'voucher', createdBy: req.user.name,
        lines: [{ accountId: debitAccountId, debit: value, memo: narration }, { accountId: creditAccountId, credit: value, memo: narration }],
      });

      db.prepare('INSERT INTO vouchers (id, tenant_id, voucher_no, type, date, narration, amount, entry_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, req.tenantId, voucherNo, type, date, narration || null, value, entry.id, req.user.name);
    })();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'A voucher was created at the same moment — please retry' });
    return res.status(400).json({ error: e.message });
  }

  audit(req, 'accounting.voucher_create', 'voucher', id, { voucherNo, type, amount: value });
  res.status(201).json(db.prepare('SELECT * FROM vouchers WHERE id = ?').get(id));
});

// ── Ledger — all postings for one account ───────────────────────────────
router.get('/ledger/:accountId', (req, res) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ? AND tenant_id = ?').get(req.params.accountId, req.tenantId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  const lines = db.prepare(`
    SELECT jl.*, je.date, je.reference, je.description, je.source FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.account_id = ? ORDER BY je.date ASC, je.created_at ASC
  `).all(account.id);
  let balance = 0;
  const rows = lines.map(l => {
    balance += account.normal_balance === 'debit' ? (l.debit - l.credit) : (l.credit - l.debit);
    return { ...l, runningBalance: balance };
  });
  res.json({ account, lines: rows, closingBalance: balance });
});

// ── Trial Balance — every account's total debit/credit as of a date ────
router.get('/trial-balance', (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  ensureDefaultAccounts(req.tenantId);
  const accounts = db.prepare('SELECT * FROM accounts WHERE tenant_id = ? AND active = 1 ORDER BY code').all(req.tenantId);
  const rows = accounts.map(a => {
    const sums = db.prepare(`
      SELECT COALESCE(SUM(jl.debit),0) as debit, COALESCE(SUM(jl.credit),0) as credit FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ? AND je.date <= ?
    `).get(a.id, asOf);
    const net = a.normal_balance === 'debit' ? sums.debit - sums.credit : sums.credit - sums.debit;
    return { account: a, debit: sums.debit, credit: sums.credit, balance: net };
  }).filter(r => r.debit !== 0 || r.credit !== 0);

  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  res.json({ asOf, rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
});

// ── Cash Book — all postings touching the Cash-on-Hand account ─────────
router.get('/cashbook', (req, res) => {
  ensureDefaultAccounts(req.tenantId);
  const cashAccount = getAccountByKey(req.tenantId, 'cash');
  if (!cashAccount) return res.json({ lines: [], openingBalance: 0, closingBalance: 0 });
  const { from, to } = req.query;
  let sql = `SELECT jl.*, je.date, je.reference, je.description, je.source FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id WHERE jl.account_id = ?`;
  const params = [cashAccount.id];
  if (from) { sql += ' AND je.date >= ?'; params.push(from); }
  if (to) { sql += ' AND je.date <= ?'; params.push(to); }
  sql += ' ORDER BY je.date ASC, je.created_at ASC';
  const lines = db.prepare(sql).all(...params);
  let balance = 0;
  const rows = lines.map(l => { balance += l.debit - l.credit; return { ...l, runningBalance: balance }; });
  res.json({ lines: rows, closingBalance: balance });
});

// ── Credit Sales — outstanding receivables report (AR accounts) ────────
router.get('/credit-sales', (req, res) => {
  const pending = db.prepare(`SELECT * FROM transactions WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at DESC`).all(req.tenantId);
  const total = pending.reduce((s, t) => s + t.amount, 0);
  res.json({ transactions: pending, total, count: pending.length });
});

