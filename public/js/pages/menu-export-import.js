// public/js/pages/menu-export-import.js
// Menu Manager ⇄ Export / Import products — same additive pattern as
// menu-categories.js: it observes the DOM and injects two header buttons
// WITHOUT touching menu.js, the POS, or any server route.
//
//   • Export  — downloads a JSON snapshot of every restaurant & bar product
//     through the existing GET /api/menu, images included (image_url can be a
//     hosted URL or an uploaded data-URL, both survive the round-trip).
//   • Import  — reads that file back and ONLY CREATES missing products via the
//     existing POST /api/menu. A row is skipped when its barcode, SKU, or
//     name+outlet already exists, so re-importing a file can never alter live
//     prices, stock, availability, or images — nothing is updated or deleted.
//
// Window hooks (also used by scripts/browser-test-menu-categories.js):
//   window.__mexiExportText()      → Promise<JSON string> of the snapshot
//   window.__mexiImport(jsonText)  → Promise<{ total, created, skipped, failed[] }>
window.PAGES = window.PAGES || {};

(function () {
  'use strict';

  const FORMAT = 'staychat-menu-export';
  const MAX_FILE = 20 * 1024 * 1024;

  const canManageProducts = () => (typeof can === 'function' ? (can('menu.manage') || can('pos.manage_products')) : true);

  // ── Export ─────────────────────────────────────────────────────────────
  // Fresh fetch (not page state) so the snapshot covers every outlet even
  // while a filter pill is active on screen.
  async function buildExportText() {
    const items = await API.get('/api/menu');
    return JSON.stringify({
      format: FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      products: (Array.isArray(items) ? items : []).map(i => ({
        name: i.name,
        description: i.description || '',
        category: i.category,
        outlet: i.outlet || 'both',
        price: i.price,
        costPrice: i.cost_price || 0,
        discountPct: i.discount_pct || 0,
        barcode: i.barcode || null,
        sku: i.sku || null,
        stockQty: (i.stock_qty === null || i.stock_qty === undefined) ? null : i.stock_qty,
        loyaltyPoints: i.loyalty_points || 0,
        available: !!i.available,
        imageUrl: i.image_url || null,
      })),
    }, null, 2);
  }
  window.__mexiExportText = buildExportText;

  function downloadJson(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ── Import (create-only) ───────────────────────────────────────────────
  // Accepts the export envelope ({ products: [...] }) or a bare array.
  // Rows are processed sequentially so a batch never trips the server's
  // request pacing, and duplicates are tracked as we go so a file that lists
  // the same barcode twice only creates one product.
  async function importProducts(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON'); }
    const rows = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.products) ? parsed.products : null);
    if (!rows || !rows.length) throw new Error('No products found in that file (expected { "products": [...] })');

    const existing = await API.get('/api/menu');
    const byBarcode = new Set();
    const bySku = new Set();
    const byNameOutlet = new Set();
    (Array.isArray(existing) ? existing : []).forEach(i => {
      if (i.barcode) byBarcode.add(String(i.barcode).toLowerCase());
      if (i.sku) bySku.add(String(i.sku).toLowerCase());
      byNameOutlet.add(String(i.name || '').trim().toLowerCase() + '|' + (i.outlet || 'both'));
    });

    const report = { total: rows.length, created: 0, skipped: 0, failed: [] };

    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') { report.failed.push({ name: '(row)', reason: 'not a product object' }); continue; }
      const name = String(raw.name || '').trim();
      const price = Number(raw.price);
      if (!name) { report.failed.push({ name: '(unnamed row)', reason: 'missing name' }); continue; }
      if (!isFinite(price) || price < 0) { report.failed.push({ name: name, reason: 'missing or invalid price' }); continue; }

      const outlet = (raw.outlet === 'restaurant' || raw.outlet === 'bar') ? raw.outlet : 'both';
      const barcode = raw.barcode ? String(raw.barcode).trim() : null;
      const sku = raw.sku ? String(raw.sku).trim() : null;
      const key = name.toLowerCase() + '|' + outlet;
      if ((barcode && byBarcode.has(barcode.toLowerCase())) ||
          (sku && bySku.has(sku.toLowerCase())) ||
          byNameOutlet.has(key)) {
        report.skipped++;
        continue;
      }

      const stock = raw.stockQty;
      try {
        await API.post('/api/menu', {
          name: name,
          description: raw.description ? String(raw.description) : null,
          category: raw.category ? String(raw.category).trim() || 'Mains' : 'Mains',
          outlet: outlet,
          price: price,
          costPrice: Number(raw.costPrice) || 0,
          discountPct: Number(raw.discountPct) || 0,
          barcode: barcode,
          sku: sku,
          stockQty: (stock === null || stock === undefined || stock === '') ? null : Number(stock),
          loyaltyPoints: Number(raw.loyaltyPoints) || 0,
          available: raw.available !== false,
          imageUrl: (typeof raw.imageUrl === 'string' && raw.imageUrl) ? raw.imageUrl : null,
        });
        report.created++;
        if (barcode) byBarcode.add(barcode.toLowerCase());
        if (sku) bySku.add(sku.toLowerCase());
        byNameOutlet.add(key);
      } catch (err) {
        report.failed.push({ name: name, reason: (err && err.message) || 'could not save' });
      }
    }
    return report;
  }

  function refreshMenuPageIfOpen() {
    const onMenu = Array.from(document.querySelectorAll('#content .page-header h1'))
      .some(h => (h.textContent || '').indexOf('Menu Manager') === 0);
    if (onMenu && typeof navigate === 'function') { try { navigate('menu'); } catch (e) { /* page reload is best-effort */ } }
  }

  function showReport(report) {
    const line = 'Imported ' + report.created + ' new product' + (report.created === 1 ? '' : 's') +
      (report.skipped ? ' · skipped ' + report.skipped + ' already in your menu' : '');
    if (report.failed.length === 0) {
      toast(line, report.created ? 'success' : 'info');
      return;
    }
    openModal('Import complete',
      '<p style="font-size:13px;color:var(--text2);margin-bottom:10px">' + escapeHtml(line) + ' · ' + report.failed.length + ' row(s) could not be read.</p>' +
      '<div style="max-height:220px;overflow:auto;border:1.5px solid var(--border);border-radius:10px">' +
      report.failed.map(f => '<div style="padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px">' +
        '<b>' + escapeHtml(f.name) + '</b> — ' + escapeHtml(f.reason) + '</div>').join('') + '</div>',
      '<button class="btn primary" onclick="closeModal()">Close</button>');
  }

  function runImport(jsonText) {
    return importProducts(jsonText).then(report => {
      if (report.created) refreshMenuPageIfOpen();
      return report;
    });
  }
  window.__mexiImport = runImport;

  // ── Header injection ───────────────────────────────────────────────────
  // menu-categories.js may have already wrapped [Add Product] in its own
  // button group — join that group when present so the header keeps one
  // right-hand cluster instead of stacking flex children.
  function injectHeaderButtons() {
    if (!canManageProducts()) return;
    const h1 = Array.from(document.querySelectorAll('#content .page-header h1'))
      .find(h => (h.textContent || '').indexOf('Menu Manager') === 0);
    if (!h1) return;
    const header = h1.closest('.page-header');
    if (!header || header.dataset.mexi) return;
    const addBtn = Array.from(header.querySelectorAll('button'))
      .find(b => (b.textContent || '').indexOf('Add Product') !== -1);
    if (!addBtn) return; // header not fully built yet — next mutation retries
    header.dataset.mexi = '1';

    let host = addBtn.parentElement;
    if (host === header || !host || host.tagName !== 'DIV') {
      host = document.createElement('div');
      host.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
      header.insertBefore(host, addBtn);
      host.appendChild(addBtn);
    }

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'btn outline';
    exportBtn.textContent = '⬇ Export';
    exportBtn.title = 'Download every restaurant & bar product as JSON (images included)';

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'btn outline';
    importBtn.textContent = '⬆ Import';
    importBtn.title = 'Add products from an exported JSON file — existing products are never changed';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_FILE) { toast('That file is too large (20MB max)', 'error'); return; }
      try {
        const report = await runImport(await file.text());
        showReport(report);
      } catch (err) {
        toast((err && err.message) || 'Import failed', 'error');
      }
    });

    exportBtn.addEventListener('click', async () => {
      exportBtn.disabled = true;
      try {
        const text = await buildExportText();
        const count = JSON.parse(text).products.length;
        const stamp = new Date().toISOString().slice(0, 10);
        downloadJson('menu-products-' + stamp + '.json', text);
        toast('Exported ' + count + ' product' + (count === 1 ? '' : 's') + ' (images included)', 'success');
      } catch (err) {
        toast((err && err.message) || 'Export failed', 'error');
      } finally { exportBtn.disabled = false; }
    });
    importBtn.addEventListener('click', () => fileInput.click());

    host.appendChild(exportBtn);
    host.appendChild(importBtn);
    host.appendChild(fileInput);
  }

  // ── Observer — everything above is injected, existing code untouched ───
  const contentObs = new MutationObserver(() => { if (canManageProducts()) injectHeaderButtons(); });

  function start() {
    const content = document.getElementById('content');
    if (content) contentObs.observe(content, { childList: true, subtree: true });
    injectHeaderButtons();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
