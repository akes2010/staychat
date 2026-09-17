// public/js/pages/printers.js
// Printer setup & management — register thermal (80mm/58mm) printers for
// Restaurant/Bar and A4 printers for the front desk. "Test Print" opens a
// correctly-sized print preview via the browser's print dialog — point it at
// the actual printer (thermal printers register as normal OS print devices),
// which is how POS/receipt printing works in practice without needing a
// native driver integration.
window.PAGES = window.PAGES || {};

const PRINTER_TYPE_LABELS = { thermal_80: 'Thermal 80mm', thermal_58: 'Thermal 58mm', a4: 'A4 Paper' };

PAGES.printers = function () {
  const wrap = el('div', 'fa');
  const state = { printers: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading printers…');
    try { state.printers = await API.get('/api/printers'); render(); }
    catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'printers\')'); }
  }

  function render() {
    const byDept = {};
    state.printers.forEach(p => { (byDept[p.department] = byDept[p.department] || []).push(p); });

    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>Printer Management</h1><p>' + state.printers.length + ' printer(s) configured</p></div>' +
      '<button class="btn primary" onclick="window.__openAddPrinter()">+ Add Printer</button></div>' +
    (state.printers.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🖨️</div><div class="empty-state-title">No printers configured</div><div class="empty-state-desc">Add thermal printers for Restaurant/Bar and an A4 printer for the front desk.</div></div>' :
    Object.keys(byDept).map(dept => '<div style="margin-bottom:20px"><div style="font-weight:700;font-size:14px;margin-bottom:10px">' + escapeHtml(dept) + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' +
        byDept[dept].map(p => '<div class="card" style="display:flex;align-items:center;gap:14px">' +
          '<div style="font-size:24px">' + (p.type === 'a4' ? '📄' : '🧾') + '</div>' +
          '<div style="flex:1"><div style="font-weight:600;font-size:13px">' + escapeHtml(p.name) + ' ' + (p.isDefault ? badge('Default', 'info') : '') + '</div>' +
            '<div style="font-size:11px;color:var(--text3)">' + PRINTER_TYPE_LABELS[p.type] + ' &middot; ' + escapeHtml(p.connection) + (p.address ? ' &middot; ' + escapeHtml(p.address) : '') + '</div></div>' +
          (p.active ? badge('Active', 'success') : badge('Inactive', 'default')) +
          '<label class="toggle"><input type="checkbox" ' + (p.active ? 'checked' : '') + ' onchange="window.__togglePrinter(\'' + p.id + '\',this.checked)"/><span class="toggle-slider"></span></label>' +
          '<button class="btn ghost sm" onclick="window.__editPrinter(\'' + p.id + '\')">Edit</button>' +
          '<button class="btn ghost sm" onclick="window.__testPrint(\'' + p.id + '\')">Test Print</button>' +
          '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deletePrinter(\'' + p.id + '\')">Delete</button>' +
        '</div>').join('') +
      '</div></div>').join(''));
  }

  window.__togglePrinter = async (id, val) => {
    try { await API.patch('/api/printers/' + id, { active: val }); toast(val ? 'Printer activated' : 'Printer deactivated', val ? 'success' : 'warn'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  window.__openAddPrinter = () => {
    openModal('Add Printer',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ap-name" placeholder="e.g. Bar Receipt Printer"/></div>' +
        '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="ap-type"><option value="thermal_80">Thermal 80mm</option><option value="thermal_58">Thermal 58mm</option><option value="a4">A4 Paper</option></select></div>' +
        '<div class="form-group"><label class="form-label">Department</label><select class="form-select" id="ap-dept"><option>Restaurant</option><option>Bar</option><option>Front Desk</option><option>Back Office</option></select></div>' +
        '<div class="form-group"><label class="form-label">Connection</label><select class="form-select" id="ap-conn"><option value="usb">USB</option><option value="network">Network</option><option value="bluetooth">Bluetooth</option></select></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">IP Address / Device ID (optional)</label><input class="form-input" id="ap-addr" placeholder="e.g. 192.168.1.50"/></div>' +
        '<div class="form-group"><label class="form-label">Set as Default for Department</label><select class="form-select" id="ap-default"><option value="false">No</option><option value="true">Yes</option></select></div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addPrinter()">Add Printer</button>'
    );
  };
  window.__addPrinter = async () => {
    const name = document.getElementById('ap-name').value.trim();
    if (!name) { toast('Printer name is required', 'error'); return; }
    try {
      await API.post('/api/printers', {
        name, type: document.getElementById('ap-type').value, department: document.getElementById('ap-dept').value,
        connection: document.getElementById('ap-conn').value, address: document.getElementById('ap-addr').value.trim(),
        isDefault: document.getElementById('ap-default').value === 'true',
      });
      toast('Printer added', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__deletePrinter = (id) => {
    confirmAction('Remove this printer?', async () => {
      try { await API.del('/api/printers/' + id); toast('Printer removed', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  window.__editPrinter = (id) => {
    const p = state.printers.find(x => x.id === id);
    if (!p) return;
    openModal('Edit Printer',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ep-name" value="' + escapeHtml(p.name) + '"/></div>' +
        '<div class="form-group"><label class="form-label">Type</label><select class="form-select" id="ep-type">' +
          '<option value="thermal_80"' + (p.type === 'thermal_80' ? ' selected' : '') + '>Thermal 80mm</option>' +
          '<option value="thermal_58"' + (p.type === 'thermal_58' ? ' selected' : '') + '>Thermal 58mm</option>' +
          '<option value="a4"' + (p.type === 'a4' ? ' selected' : '') + '>A4 Paper</option></select></div>' +
        '<div class="form-group"><label class="form-label">Department</label><select class="form-select" id="ep-dept">' +
          ['Restaurant','Bar','Front Desk','Back Office'].map(d => '<option' + (p.department === d ? ' selected' : '') + '>' + d + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Connection</label><select class="form-select" id="ep-conn">' +
          '<option value="usb"' + (p.connection === 'usb' ? ' selected' : '') + '>USB</option>' +
          '<option value="network"' + (p.connection === 'network' ? ' selected' : '') + '>Network</option>' +
          '<option value="bluetooth"' + (p.connection === 'bluetooth' ? ' selected' : '') + '>Bluetooth</option></select></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">IP Address / Device ID (optional)</label><input class="form-input" id="ep-addr" value="' + escapeHtml(p.address || '') + '"/></div>' +
        '<div class="form-group"><label class="form-label">Set as Default for Department</label><select class="form-select" id="ep-default"><option value="false">No</option><option value="true"' + (p.isDefault ? ' selected' : '') + '>Yes</option></select></div>' +
        '<div class="form-group"><label class="form-label">Status</label><select class="form-select" id="ep-active"><option value="true"' + (p.active ? ' selected' : '') + '>Active</option><option value="false"' + (!p.active ? ' selected' : '') + '>Inactive</option></select></div>' +
      '</div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__savePrinter(\'' + id + '\')">Save Changes</button>'
    );
  };
  window.__savePrinter = async (id) => {
    const name = document.getElementById('ep-name').value.trim();
    if (!name) { toast('Printer name is required', 'error'); return; }
    try {
      await API.patch('/api/printers/' + id, {
        name, type: document.getElementById('ep-type').value, department: document.getElementById('ep-dept').value,
        connection: document.getElementById('ep-conn').value, address: document.getElementById('ep-addr').value.trim(),
        isDefault: document.getElementById('ep-default').value === 'true', active: document.getElementById('ep-active').value === 'true',
      });
      toast('Printer updated', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__testPrint = (id) => {
    const p = state.printers.find(x => x.id === id);
    const width = p.type === 'thermal_58' ? '58mm' : p.type === 'thermal_80' ? '80mm' : '210mm';
    printReceiptWindow({
      hotelName: (App.tenant && App.tenant.name) || 'Hotel',
      subtitle: p.name + ' — ' + PRINTER_TYPE_LABELS[p.type],
      title: 'TEST PRINT',
      meta: [['Date', new Date().toLocaleString()], ['Department', p.department], ['Connection', p.connection]],
      lines: [['Sample Item', '1', formatMoney(10)]],
      totals: [['Total', formatMoney(10), true]],
      footer: 'This confirms ' + p.name + ' is set up correctly.',
    }, width);
  };

  load();
  return wrap;
};
