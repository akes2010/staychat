// public/js/pages/menu.js
// Menu Manager doubles as POS Product Management — every item here is what
// populates the Point of Sale menu grid (restaurant/bar) and Room Service.
window.PAGES = window.PAGES || {};

PAGES.menu = function () {
  const wrap = el('div', 'fa');
  const state = { menu: [], view: 'grid', search: '', outletFilter: 'all' };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading products…');
    try { state.menu = await API.get('/api/menu'); render(); }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'menu\')'); }
  }

  const CATS = ['Mains','Starters','Salads','Desserts','Drinks','Snacks','Cocktails','Beer','Wine','Spirits','Bar Snacks'];
  const outletBadge = (o) => o === 'restaurant' ? badge('Restaurant', 'info') : o === 'bar' ? badge('Bar', 'default') : badge('Both', 'success');
  const canManage = typeof can === 'function' ? (can('menu.manage') || can('pos.manage_products')) : true;

  function margin(item) {
    if (!item.cost_price) return null;
    const m = ((item.price - item.cost_price) / item.price) * 100;
    return Math.round(m);
  }

  function render() {
    let items = state.menu.slice();
    if (state.outletFilter !== 'all') items = items.filter(m => m.outlet === state.outletFilter || m.outlet === 'both');
    if (state.search) {
      const q = state.search.toLowerCase();
      items = items.filter(m => m.name.toLowerCase().includes(q) || (m.sku || '').toLowerCase().includes(q) || (m.barcode || '').includes(q));
    }
    const cats = []; items.forEach(m => { if (cats.indexOf(m.category) === -1) cats.push(m.category); });

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Menu Manager / Products</h1><p>' + state.menu.length + ' products &middot; ' + state.menu.filter(m => m.available).length + ' available</p></div>' +
      (canManage ? '<button class="btn primary" onclick="window.__openAddMenuItem()">+ Add Product</button>' : '') + '</div>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">' +
      '<input class="form-input" style="max-width:260px" placeholder="Search name, SKU, or barcode…" value="' + escapeHtml(state.search) + '" oninput="window.__menuSearch(this.value)"/>' +
      '<div class="filter-pills">' +
        '<button class="pill ' + (state.outletFilter === 'all' ? 'active' : '') + '" onclick="window.__menuOutletFilter(\'all\')">All</button>' +
        '<button class="pill ' + (state.outletFilter === 'restaurant' ? 'active' : '') + '" onclick="window.__menuOutletFilter(\'restaurant\')">🍽 Restaurant</button>' +
        '<button class="pill ' + (state.outletFilter === 'bar' ? 'active' : '') + '" onclick="window.__menuOutletFilter(\'bar\')">🍸 Bar</button>' +
      '</div>' +
    '</div>' +
    (cats.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🍽</div><div class="empty-state-title">No products match</div></div>' : '') +
    cats.map(cat => {
      const catItems = items.filter(m => m.category === cat);
      return '<div style="margin-bottom:24px"><div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:8px">' + escapeHtml(cat) + badge(String(catItems.length), 'default') + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
        catItems.map(item => {
          const m = margin(item);
          return '<div style="background:var(--surface);border:1.5px solid var(--border);border-radius:var(--radius-lg);padding:12px 16px;display:flex;align-items:center;gap:14px;opacity:' + (item.available ? 1 : .6) + '">' +
          (item.image_url
            ? '<img src="' + escapeHtml(item.image_url) + '" style="width:44px;height:44px;border-radius:9px;object-fit:cover;flex-shrink:0;background:var(--surface2)" onerror="this.style.display=\'none\'"/>'
            : '<div style="width:44px;height:44px;border-radius:9px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🍽</div>') +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-weight:600;font-size:13px;margin-bottom:2px">' + escapeHtml(item.name) + (item.discount_pct ? ' ' + badge('-' + item.discount_pct + '%', 'warn') : '') + '</div>' +
            '<div style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(item.description || '') + '</div>' +
            '<div style="font-size:10px;color:var(--text3);margin-top:3px">' + (item.sku ? 'SKU: ' + escapeHtml(item.sku) : '') + (item.sku && item.barcode ? ' &middot; ' : '') + (item.barcode ? 'Barcode: ' + escapeHtml(item.barcode) : '') + (item.stock_qty !== null && item.stock_qty !== undefined ? ((item.sku || item.barcode) ? ' &middot; ' : '') + 'Stock: ' + item.stock_qty : '') + (item.loyalty_points ? ' &middot; ' + item.loyalty_points + ' pts' : '') + '</div>' +
          '</div>' +
          outletBadge(item.outlet) +
          '<div style="text-align:right;min-width:70px">' +
            '<div style="font-weight:800;font-size:15px;color:var(--p)">' + formatMoney(item.discount_pct ? item.price * (1 - item.discount_pct / 100) : item.price) + '</div>' +
            (item.discount_pct ? '<div style="font-size:11px;color:var(--text3);text-decoration:line-through">' + formatMoney(item.price) + '</div>' : '') +
            (m !== null ? '<div style="font-size:10px;color:' + (m >= 0 ? 'var(--a)' : 'var(--error)') + '">' + m + '% margin</div>' : '') +
          '</div>' +
          (canManage ? '<label class="toggle"><input type="checkbox" ' + (item.available ? 'checked' : '') + ' onchange="window.__toggleMenuItem(\'' + item.id + '\',this.checked)"/><span class="toggle-slider"></span></label>' : statusBadge(item.available ? 'active' : 'off-duty')) +
          (canManage ? '<button class="btn ghost sm" onclick="window.__editMenuItem(\'' + item.id + '\')">Edit</button>' +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteMenuItem(\'' + item.id + '\')">Delete</button>' : '') +
          '</div>';
        }).join('') +
      '</div></div>';
    }).join('');
  }

  window.__menuSearch = (v) => { state.search = v; render(); const inp = wrap.querySelector('input.form-input'); if (inp) { inp.focus(); inp.selectionStart = inp.selectionEnd = v.length; } };
  window.__menuOutletFilter = (v) => { state.outletFilter = v; render(); };

  window.__toggleMenuItem = async (id, val) => {
    try { await API.patch('/api/menu/' + id, { available: val }); toast(val ? 'Product now available' : 'Product marked unavailable', val ? 'success' : 'warn'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteMenuItem = (id) => {
    confirmAction('Delete this product? This cannot be undone.', async () => {
      try { await API.del('/api/menu/' + id); toast('Product deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Shared product form (used for both Add and Edit) ───────────────────
  let pendingImageDataUrl = null;

  function productFormHTML(prefix, item) {
    item = item || {};
    pendingImageDataUrl = item.image_url || null;
    return '' +
    '<div style="display:flex;gap:16px;margin-bottom:14px;align-items:flex-start">' +
      '<div style="flex-shrink:0">' +
        '<div id="' + prefix + '-img-preview" style="width:84px;height:84px;border-radius:12px;background:var(--surface2);border:1.5px dashed var(--border-dark);display:flex;align-items:center;justify-content:center;overflow:hidden">' +
          (item.image_url ? '<img src="' + escapeHtml(item.image_url) + '" style="width:100%;height:100%;object-fit:cover"/>' : '<span style="font-size:26px">📷</span>') +
        '</div>' +
        '<label class="btn outline sm" style="margin-top:8px;display:block;text-align:center;cursor:pointer">Upload<input type="file" accept="image/*" style="display:none" onchange="window.__menuImagePick(event,\'' + prefix + '\')"/></label>' +
      '</div>' +
      '<div style="flex:1">' +
        '<div class="form-group" style="margin-bottom:10px"><label class="form-label">Product Name</label><input class="form-input" id="' + prefix + '-name" placeholder="e.g. Grilled Salmon" value="' + escapeHtml(item.name || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Image URL (optional, alternative to upload)</label><input class="form-input" id="' + prefix + '-imgurl" placeholder="https://…" value="' + escapeHtml(item.image_url || '') + '" oninput="window.__menuImageUrlInput(this.value,\'' + prefix + '\')"/></div>' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Description</label><input class="form-input" id="' + prefix + '-desc" placeholder="Short description…" value="' + escapeHtml(item.description || '') + '"/></div>' +
    '<div class="form-row cols-2" style="margin-bottom:2px">' +
      '<div class="form-group"><label class="form-label">Category</label><select class="form-select" id="' + prefix + '-cat">' + CATS.map(c => '<option' + (item.category === c ? ' selected' : '') + '>' + c + '</option>').join('') + '</select></div>' +
      '<div class="form-group"><label class="form-label">Outlet</label><select class="form-select" id="' + prefix + '-outlet">' +
        '<option value="both"' + (!item.outlet || item.outlet === 'both' ? ' selected' : '') + '>Both / Room Service</option>' +
        '<option value="restaurant"' + (item.outlet === 'restaurant' ? ' selected' : '') + '>Restaurant Only</option>' +
        '<option value="bar"' + (item.outlet === 'bar' ? ' selected' : '') + '>Bar Only</option></select></div>' +
      '<div class="form-group"><label class="form-label">Cost Price ($)</label><input class="form-input" type="number" step="0.01" min="0" id="' + prefix + '-cost" placeholder="0.00" value="' + (item.cost_price || '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Selling Price ($)</label><input class="form-input" type="number" step="0.01" min="0" id="' + prefix + '-price" placeholder="0.00" value="' + (item.price !== undefined ? item.price : '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Discount (%)</label><input class="form-input" type="number" step="1" min="0" max="100" id="' + prefix + '-discount" placeholder="0" value="' + (item.discount_pct || '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Stock Qty (optional)</label><input class="form-input" type="number" step="1" min="0" id="' + prefix + '-stock" placeholder="Leave blank if untracked" value="' + (item.stock_qty !== null && item.stock_qty !== undefined ? item.stock_qty : '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">SKU</label><input class="form-input" id="' + prefix + '-sku" placeholder="e.g. RST-0142" value="' + escapeHtml(item.sku || '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Barcode</label><input class="form-input" id="' + prefix + '-barcode" placeholder="e.g. 6009876543210" value="' + escapeHtml(item.barcode || '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Loyalty Points (per unit)</label><input class="form-input" type="number" step="1" min="0" id="' + prefix + '-loyalty" placeholder="0" value="' + (item.loyalty_points || '') + '"/></div>' +
      '<div class="form-group"><label class="form-label">Available for Sale</label><select class="form-select" id="' + prefix + '-avail"><option value="true"' + (item.available !== false ? ' selected' : '') + '>Yes</option><option value="false"' + (item.available === false ? ' selected' : '') + '>No</option></select></div>' +
    '</div>';
  }

  function readForm(prefix) {
    const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
    return {
      name: val(prefix + '-name').trim(),
      description: val(prefix + '-desc'),
      category: val(prefix + '-cat'),
      outlet: val(prefix + '-outlet'),
      costPrice: Number(val(prefix + '-cost') || 0),
      price: Number(val(prefix + '-price') || 0),
      discountPct: Number(val(prefix + '-discount') || 0),
      stockQty: val(prefix + '-stock') === '' ? null : Number(val(prefix + '-stock')),
      sku: val(prefix + '-sku').trim() || null,
      barcode: val(prefix + '-barcode').trim() || null,
      loyaltyPoints: Number(val(prefix + '-loyalty') || 0),
      available: val(prefix + '-avail') === 'true',
      imageUrl: pendingImageDataUrl || null,
    };
  }

  window.__menuImagePick = (evt, prefix) => {
    const file = evt.target.files[0];
    if (!file) return;
    if (file.size > 1.5 * 1024 * 1024) { toast('Please choose an image under 1.5MB', 'error'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      pendingImageDataUrl = reader.result;
      const preview = document.getElementById(prefix + '-img-preview');
      if (preview) preview.innerHTML = '<img src="' + reader.result + '" style="width:100%;height:100%;object-fit:cover"/>';
      const urlInput = document.getElementById(prefix + '-imgurl');
      if (urlInput) urlInput.value = '';
    };
    reader.readAsDataURL(file);
  };
  window.__menuImageUrlInput = (v, prefix) => {
    pendingImageDataUrl = v.trim() || null;
    const preview = document.getElementById(prefix + '-img-preview');
    if (preview) preview.innerHTML = v.trim() ? '<img src="' + escapeHtml(v.trim()) + '" style="width:100%;height:100%;object-fit:cover" onerror="this.parentElement.innerHTML=\'<span style=font-size:26px>📷</span>\'"/>' : '<span style="font-size:26px">📷</span>';
  };

  window.__openAddMenuItem = () => {
    openModal('Add Product', productFormHTML('am', null),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addMenuItem()">Add Product</button>',
      { wide: true }
    );
  };
  window.__addMenuItem = async () => {
    const data = readForm('am');
    if (!data.name) { toast('Product name is required', 'error'); return; }
    if (!data.price) { toast('Selling price is required', 'error'); return; }
    try {
      await API.post('/api/menu', data);
      toast('Product added', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__editMenuItem = (id) => {
    const item = state.menu.find(m => m.id === id);
    if (!item) return;
    openModal('Edit Product', productFormHTML('em', item),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveMenuItem(\'' + id + '\')">Save Changes</button>',
      { wide: true }
    );
  };
  window.__saveMenuItem = async (id) => {
    const data = readForm('em');
    if (!data.name) { toast('Product name is required', 'error'); return; }
    try {
      await API.patch('/api/menu/' + id, data);
      toast('Product updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
