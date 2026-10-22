// public/js/pages/menu-categories.js
// Menu Manager "+" — create a new category when it isn't available yet.
//
// The Add/Edit Product form's Category dropdown used to be a fixed list, so a
// category that wasn't already on it simply "wasn't available" with no way to
// add it. This module adds that "+", WITHOUT touching public/js/pages/menu.js
// — it observes the DOM and, for users who may manage products, injects:
//   • a "+ New Category" button in the Menu Manager page header (opens a small
//     standalone modal showing the already-available categories as chips), and
//   • a "+" button and a "＋ New Category…" option on the Category select of
//     the Add/Edit Product modal, with an inline name row right below it (the
//     app has ONE modal container, so a nested modal would destroy the product
//     form — inline is the only safe place to ask for the name).
// Created names persist per-tenant via /api/menu/categories (merged with the
// categories in use by menu_items), so they stay selectable after a reload.
window.PAGES = window.PAGES || {};

(function () {
  'use strict';

  const SENTINEL = '__mc_new__';
  const MAX_LEN = 60;

  const canManageCats = () => (typeof can === 'function' ? (can('menu.manage') || can('pos.manage_products')) : true);

  // ── Server-side vocabulary ──────────────────────────────────────────────
  let catsCache = null;
  function fetchCats(useCache) {
    if (useCache && catsCache) return Promise.resolve(catsCache);
    return API.get('/api/menu/categories')
      .then(list => { catsCache = Array.isArray(list) ? list : []; return catsCache; })
      .catch(() => catsCache || []); // offline/failed → keep what we already know
  }

  // Shared create used by both entry points. Resolves with
  //   { name }     — category created
  //   { existing } — it was already available (case-insensitive); the caller
  //                  should select/point at that one instead.
  async function postCategory(rawName) {
    const name = String(rawName || '').trim().replace(/\s+/g, ' ');
    if (!name) throw new Error('Type a category name first');
    if (name.length > MAX_LEN) throw new Error('Category name must be ' + MAX_LEN + ' characters or fewer');

    const known = await fetchCats(true);
    const dup = known.find(c => String(c).toLowerCase() === name.toLowerCase());
    if (dup) return { existing: dup };

    try {
      const created = await API.post('/api/menu/categories', { name });
      await fetchCats(false); // refresh BEFORE returning so any dropdown that
                              // enhances right after this create already lists
                              // the new name (no stale-cache window)
      return { name: (created && created.name) || name };
    } catch (err) {
      // 409 → already available (created on another device since our cache).
      if (err.status === 409 && err.data && err.data.existing) return { existing: err.data.existing };
      throw err;
    }
  }

  // ── Option helpers (selects keep "＋ New Category…" as the LAST option) ──
  function optionByText(select, name) {
    const k = String(name).toLowerCase();
    return Array.from(select.options).find(o => o && o.value !== SENTINEL && String(o.textContent).toLowerCase() === k) || null;
  }
  function addOption(select, name, sentinel) {
    const existing = optionByText(select, name);
    if (existing) return existing;
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.insertBefore(opt, sentinel || null);
    return opt;
  }

  // ── Edit-product hook ───────────────────────────────────────────────────
  // The product form renders its Category options from a FIXED list, so an
  // item whose category isn't on that list would fall back to the first
  // option — and a plain "Save" would silently rewrite its category. menu.js
  // re-assigns window.__editMenuItem every time the page renders, so we re-arm
  // this wrapper on every #content mutation: fetch the item FIRST (so its real
  // category is known before the modal opens — no restore race), then delegate
  // to the original handler unchanged.
  const pending = { id: null, item: null };

  function armEditHook() {
    const orig = window.__editMenuItem;
    if (typeof orig !== 'function' || orig.__mcWrapped) return;
    const wrapped = function (id) {
      const args = arguments, self = this;
      API.get('/api/menu')
        .then(items => ({ id, item: Array.isArray(items) ? items.find(i => i.id === id) || null : null }),
              () => ({ id, item: null }))
        .then(r => { pending.id = r.id; pending.item = r.item; orig.apply(self, args); });
    };
    wrapped.__mcWrapped = true;
    window.__editMenuItem = wrapped;
  }

  // ── Add/Edit Product modal: enhance the Category field ──────────────────
  function enhanceFormSelect(sel) {
    if (sel.dataset.mcEnhanced) return;
    sel.dataset.mcEnhanced = '1';
    const editItem = pending.id ? pending.item : null;
    pending.id = null; pending.item = null;

    const state = { lastCat: sel.value || '' };

    // [select][+] row — the visible plus.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    sel.parentNode.insertBefore(row, sel);
    row.appendChild(sel);
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'btn outline sm';
    plus.title = 'New category';
    plus.textContent = '+';
    row.appendChild(plus);

    // Sentinel option, always last.
    const sentinel = document.createElement('option');
    sentinel.value = SENTINEL;
    sentinel.textContent = '＋ New Category…';
    sel.appendChild(sentinel);

    // Inline creator row — lives INSIDE the product modal (single modal
    // container: a nested modal would blow the product form away).
    const creator = document.createElement('div');
    creator.style.cssText = 'display:none;gap:6px;align-items:center;margin-top:8px';
    const input = document.createElement('input');
    input.className = 'form-input';
    input.maxLength = MAX_LEN;
    input.placeholder = 'New category name…';
    input.style.cssText = 'flex:1;min-width:120px';
    const addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.className = 'btn primary sm'; addBtn.textContent = 'Create';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'btn ghost sm'; cancelBtn.textContent = '✕';
    creator.appendChild(input);
    creator.appendChild(addBtn);
    creator.appendChild(cancelBtn);
    row.parentNode.insertBefore(creator, row.nextSibling);

    const show = () => { creator.style.display = 'flex'; input.focus(); input.select(); };
    const hide = () => { creator.style.display = 'none'; input.value = ''; };
    const settle = (name) => {
      const opt = addOption(sel, name, sentinel);
      sel.value = opt.value;
      state.lastCat = opt.value;
      hide();
    };

    sel.addEventListener('change', () => {
      if (sel.value === SENTINEL) { sel.value = state.lastCat; show(); } // never leave the sentinel as the value
      else { state.lastCat = sel.value; hide(); }
    });
    plus.addEventListener('click', show);
    cancelBtn.addEventListener('click', () => { hide(); if (sel.value === SENTINEL) sel.value = state.lastCat; });

    const submit = async () => {
      addBtn.disabled = true;
      try {
        const r = await postCategory(input.value);
        if (r.existing) {
          settle(r.existing);
          toast('“' + r.existing + '” is already available — selected it', 'info');
        } else {
          settle(r.name);
          toast('Category “' + r.name + '” created', 'success');
        }
      } catch (err) {
        toast(err.message || 'Could not create category', 'error');
        input.focus();
      } finally { addBtn.disabled = false; }
    };
    addBtn.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });

    // Edit: put the product's own category back as an option + selection
    // (synchronous here: pending.item was fetched BEFORE the modal opened).
    if (editItem && editItem.category) {
      const opt = addOption(sel, editItem.category, sentinel);
      sel.value = opt.value;
      state.lastCat = opt.value;
    }
    // Make everything else the server knows selectable too (cached after the
    // first call; appending options never changes the current selection).
    fetchCats(true).then(list => { list.forEach(n => addOption(sel, n, sentinel)); });
  }

  function enhanceModal() {
    if (!canManageCats()) return;
    const c = document.getElementById('modal-container');
    if (!c) return;
    const sel = c.querySelector('#am-cat, #em-cat');
    if (sel && !sel.dataset.mcEnhanced) enhanceFormSelect(sel);
  }

  // ── Menu Manager page header: "+ New Category" button ───────────────────
  function injectHeaderButton() {
    if (!canManageCats()) return;
    const h1 = Array.from(document.querySelectorAll('#content .page-header h1'))
      .find(h => (h.textContent || '').indexOf('Menu Manager') === 0);
    if (!h1) return;
    const header = h1.closest('.page-header');
    if (!header || header.dataset.mcCat) return;
    const addBtn = Array.from(header.querySelectorAll('button'))
      .find(b => (b.textContent || '').indexOf('Add Product') !== -1);
    if (!addBtn) return; // header not fully built yet — next mutation retries
    header.dataset.mcCat = '1';
    // Keep the header's space-between layout: group both right-hand buttons
    // in one flex container instead of adding a third flex child.
    const group = document.createElement('div');
    group.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
    header.insertBefore(group, addBtn);
    group.appendChild(addBtn);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn outline';
    btn.textContent = '+ New Category';
    btn.addEventListener('click', openPageCategoryModal);
    group.appendChild(btn);
  }

  function openPageCategoryModal() {
    openModal('New Category',
      '<p style="font-size:13px;color:var(--text2);margin-bottom:12px">Create a category for Menu Manager products. It appears in the Category dropdown even before any product sits in it.</p>' +
      '<div class="form-group"><label class="form-label">Category name</label>' +
      '<input class="form-input" id="mc-name" maxlength="' + MAX_LEN + '" placeholder="e.g. Shisha, Tapas, Happy Hour…" /></div>' +
      '<div id="mc-chips" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px"></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button>' +
      '<button class="btn primary" id="mc-create">Create Category</button>');
    const input = document.getElementById('mc-name');
    const go = async () => {
      try {
        const r = await postCategory(input.value);
        if (r.existing) { toast('“' + r.existing + '” is already available', 'info'); closeModal(); }
        else { toast('Category “' + r.name + '” created', 'success'); closeModal(); }
      } catch (err) { toast(err.message || 'Could not create category', 'error'); input.focus(); }
    };
    document.getElementById('mc-create').addEventListener('click', go);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    renderChips();
    input.focus();
  }

  function renderChips() {
    const box = document.getElementById('mc-chips');
    if (!box) return;
    fetchCats(true).then(list => {
      if (!box.isConnected) return; // modal already closed
      box.innerHTML = list.length
        ? '<span style="font-size:11px;color:var(--text3)">Available:</span>' + list.map(c =>
            '<span style="background:var(--surface2);border-radius:var(--radius-full);padding:3px 9px;font-size:11px;color:var(--text2)">' + escapeHtml(c) + '</span>').join('')
        : '<span style="font-size:11px;color:var(--text3)">No categories yet.</span>';
    });
  }

  // ── Observers — everything above is injected, previous code untouched ───
  const modalObs = new MutationObserver(enhanceModal);
  const contentObs = new MutationObserver(() => { if (canManageCats()) { armEditHook(); injectHeaderButton(); } });

  function start() {
    const mc = document.getElementById('modal-container');
    const content = document.getElementById('content');
    if (mc) modalObs.observe(mc, { childList: true, subtree: true });
    if (content) contentObs.observe(content, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
