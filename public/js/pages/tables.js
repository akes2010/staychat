// public/js/pages/tables.js
// Tables & Seating — table management for the restaurant and bar floor.
// Each table carries its sitting setting (Standard, Booth, Window Side, Bar
// Counter, Lounge, Outdoor, VIP / Private), the number of chairs per table,
// the outlet it belongs to (location: restaurant | bar) and an active flag a
// manager can flip without deleting the row — mirroring the halls/pool/gym
// page-module structure.
window.PAGES = window.PAGES || {};

PAGES.tables = function () {
  const wrap = el('div', 'fa');
  const state = { tables: [], filter: 'all' };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading tables…');
    try { state.tables = await API.get('/api/tables'); render(); }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'tables\')'); }
  }

  const SITTINGS = ['Standard', 'Booth', 'Window Side', 'Bar Counter', 'Lounge', 'Outdoor', 'VIP / Private'];
  const LOCATIONS = ['restaurant', 'bar'];
  const canManage = typeof can === 'function' ? can('tables.manage') : true;
  const locLabel = (l) => l === 'bar' ? 'Bar' : 'Restaurant';
  const locIcon = (l) => l === 'bar' ? '🍸' : '🍽';

  function render() {
    let tables = state.tables.slice();
    if (state.filter !== 'all') tables = tables.filter(t => t.location === state.filter);
    const locations = LOCATIONS.filter(l => tables.some(t => t.location === l));
    const totalChairs = state.tables.reduce((n, t) => n + (t.chairs || 0), 0);

    wrap.innerHTML = '' +
      '<div class="page-header"><div class="page-header-left"><h1>Tables & Seating</h1><p>' +
        state.tables.length + ' tables &middot; ' + totalChairs + ' chairs &middot; ' +
        state.tables.filter(t => t.active).length + ' active</p></div>' +
        (canManage ? '<button class="btn primary" onclick="window.__openAddTable()">+ Add Table</button>' : '') + '</div>' +
      '<div class="filter-pills" style="margin-bottom:16px">' +
        '<button class="pill ' + (state.filter === 'all' ? 'active' : '') + '" onclick="window.__tableFilter(\'all\')">All</button>' +
        '<button class="pill ' + (state.filter === 'restaurant' ? 'active' : '') + '" onclick="window.__tableFilter(\'restaurant\')">🍽 Restaurant</button>' +
        '<button class="pill ' + (state.filter === 'bar' ? 'active' : '') + '" onclick="window.__tableFilter(\'bar\')">🍸 Bar</button>' +
      '</div>' +
      (state.tables.length === 0
        ? '<div class="empty-state"><div class="empty-state-icon">🪑</div><div class="empty-state-title">No tables yet</div>' +
          '<div class="empty-state-desc">Add your restaurant and bar tables — sitting setting, chairs per table and location.</div></div>'
        : tables.length === 0
          ? '<div class="empty-state"><div class="empty-state-icon">🪑</div><div class="empty-state-title">No tables in this location</div></div>'
          : locations.map(locSection).join(''));
  }

  function locSection(loc) {
    const rows = state.tables.filter(t => t.location === loc && (state.filter === 'all' || state.filter === loc));
    if (rows.length === 0) return '';
    const chairs = rows.reduce((n, t) => n + (t.chairs || 0), 0);
    return '<div style="margin-bottom:24px">' +
      '<div style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:10px;display:flex;align-items:center;gap:8px">' +
        locIcon(loc) + ' ' + locLabel(loc) + badge(String(rows.length) + ' tables · ' + chairs + ' chairs', 'default') + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' + rows.map(tableRow).join('') + '</div></div>';
  }

  function tableRow(t) {
    return '<div style="background:var(--surface);border:1.5px solid var(--border);border-radius:var(--radius-lg);padding:12px 16px;display:flex;align-items:center;gap:14px;opacity:' + (t.active ? 1 : .6) + '">' +
      '<div style="width:44px;height:44px;border-radius:9px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">' + locIcon(t.location) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-weight:600;font-size:13px;margin-bottom:2px">' + escapeHtml(t.name) + (t.active ? '' : ' ' + badge('Inactive', 'default')) + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">' + escapeHtml(t.sitting) + ' sitting &middot; ' + t.chairs + ' chairs &middot; ' + (t.persons || 0) + ' persons &middot; ' + locLabel(t.location) + '</div>' +
      '</div>' +
      badge(t.sitting, 'info') +
      '<div style="text-align:right;min-width:70px"><div style="font-weight:800;font-size:15px;color:var(--p)">' + t.chairs + '</div><div style="font-size:10px;color:var(--text3)">chairs</div></div>' +
      (canManage
        ? '<label class="toggle"><input type="checkbox" ' + (t.active ? 'checked' : '') + ' onchange="window.__toggleTable(\'' + t.id + '\',this.checked)"/><span class="toggle-slider"></span></label>' +
          '<button class="btn ghost sm" onclick="window.__editTable(\'' + t.id + '\')">Edit</button>' +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteTable(\'' + t.id + '\')">Delete</button>'
        : (t.active ? statusBadge('active') : statusBadge('off-duty'))) +
      '</div>';
  }

  window.__tableFilter = (v) => { state.filter = v; render(); };

  window.__toggleTable = async (id, val) => {
    try { await API.patch('/api/tables/' + id, { active: val }); toast(val ? 'Table is now active' : 'Table marked inactive', val ? 'success' : 'warn'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteTable = (id) => {
    confirmAction('Delete this table? This cannot be undone.', async () => {
      try { await API.del('/api/tables/' + id); toast('Table deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  // ── Shared table form (used for both Add and Edit) ──────────────────────
  function tableFormHTML(prefix, t) {
    t = t || {};
    return '' +
      '<div class="form-group" style="margin-bottom:12px"><label class="form-label">Table Name</label>' +
        '<input class="form-input" id="' + prefix + '-name" placeholder="e.g. Table 1, Window Seat, Bar High 3" value="' + escapeHtml(t.name || '') + '"/></div>' +
      '<div class="form-row cols-2" style="margin-bottom:2px">' +
        '<div class="form-group"><label class="form-label">Sitting Setting</label><select class="form-select" id="' + prefix + '-sitting">' +
          SITTINGS.map(s => '<option' + (t.sitting === s ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Chairs per Table</label>' +
          '<input class="form-input" type="number" step="1" min="1" max="50" id="' + prefix + '-chairs" placeholder="4" value="' + (t.chairs !== undefined && t.chairs !== null ? t.chairs : '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Persons per Table</label>' +
          '<input class="form-input" type="number" step="1" min="1" max="50" id="' + prefix + '-persons" placeholder="5" value="' + (t.persons !== undefined && t.persons !== null ? t.persons : '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Location</label><select class="form-select" id="' + prefix + '-loc">' +
          '<option value="restaurant"' + (!t.location || t.location === 'restaurant' ? ' selected' : '') + '>🍽 Restaurant</option>' +
          '<option value="bar"' + (t.location === 'bar' ? ' selected' : '') + '>🍸 Bar</option></select></div>' +
        (t.id
          ? '<div class="form-group"><label class="form-label">Active</label><select class="form-select" id="' + prefix + '-active">' +
            '<option value="true"' + (t.active !== false ? ' selected' : '') + '>Yes</option>' +
            '<option value="false"' + (t.active === false ? ' selected' : '') + '>No</option></select></div>'
          : '') +
      '</div>';
  }

  function readForm(prefix) {
    const val = (id) => { const e = document.getElementById(id); return e ? e.value : ''; };
    return {
      name: val(prefix + '-name').trim(),
      sitting: val(prefix + '-sitting'),
      chairs: val(prefix + '-chairs') === '' ? undefined : Number(val(prefix + '-chairs')),
      persons: val(prefix + '-persons') === '' ? undefined : Number(val(prefix + '-persons')),
      location: val(prefix + '-loc'),
    };
  }

  window.__openAddTable = () => {
    openModal('Add Table', tableFormHTML('at', null),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addTable()">Add Table</button>'
    );
  };
  window.__addTable = async () => {
    const data = readForm('at');
    if (!data.name) { toast('Table name is required', 'error'); return; }
    try {
      await API.post('/api/tables', data);
      toast('Table added', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__editTable = (id) => {
    const t = state.tables.find(x => x.id === id);
    if (!t) return;
    openModal('Edit Table', tableFormHTML('et', t),
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__saveTable(\'' + id + '\')">Save Changes</button>'
    );
  };
  window.__saveTable = async (id) => {
    const data = readForm('et');
    if (!data.name) { toast('Table name is required', 'error'); return; }
    const activeEl = document.getElementById('et-active');
    if (activeEl) data.active = activeEl.value === 'true';
    try {
      await API.patch('/api/tables/' + id, data);
      toast('Table updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();
  return wrap;
};
