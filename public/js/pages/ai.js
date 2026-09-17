// public/js/pages/ai.js
// AI Setup & Configuration — pick a provider/model to power an agent role
// (e.g. the WhatsApp receptionist), store its key, and flag a monthly
// surcharge if the hotel is being billed extra for using it. This page
// manages CONFIGURATION only; it does not itself call any AI provider.
window.PAGES = window.PAGES || {};

const AI_PROVIDER_LABELS = {
  openai: 'OpenAI (ChatGPT)', qwen: 'Qwen', deepseek: 'DeepSeek', huggingface: 'Hugging Face',
  openrouter: 'OpenRouter', kimi: 'Kimi', zai: 'Z.ai', other: 'Other',
};

PAGES.ai = function () {
  const wrap = el('div', 'fa');
  const state = { configs: [], providers: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading AI configuration…');
    try {
      const [configs, providers] = await Promise.all([API.get('/api/ai-config'), API.get('/api/ai-config/providers')]);
      state.configs = configs; state.providers = providers;
      render();
    } catch (err) { wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'ai\')'); }
  }

  function render() {
    const monthlyTotal = state.configs.filter(c => c.active).reduce((s, c) => s + c.monthly_surcharge, 0);
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>AI Setup &amp; Configuration</h1><p>' + state.configs.length + ' agent configuration(s)</p></div>' +
      '<button class="btn primary" onclick="window.__openAddConfig()">+ Add AI Agent</button></div>' +
    '<div class="grid grid-3" style="margin-bottom:20px">' + metricCard('Active Agents', String(state.configs.filter(c => c.active).length), null, '🤖') + metricCard('Monthly AI Add-on Cost', formatMoney(monthlyTotal), null, '💵') + '</div>' +
    (state.configs.length === 0 ? '<div class="empty-state"><div class="empty-state-icon">🤖</div><div class="empty-state-title">No AI agents configured</div><div class="empty-state-desc">Connect a provider to power your WhatsApp receptionist or another agent role.</div></div>' :
    '<div style="display:flex;flex-direction:column;gap:10px">' + state.configs.map(c => '<div class="card" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:200px"><div style="font-weight:700;font-size:14px">' + escapeHtml(c.label) + ' ' + badge(AI_PROVIDER_LABELS[c.provider] || c.provider, 'info') + '</div>' +
        '<div style="font-size:12px;color:var(--text3)">Agent role: ' + escapeHtml(c.agent_role) + (c.model ? ' &middot; Model: ' + escapeHtml(c.model) : '') + ' &middot; Key: ' + (c.apiKeyMasked || 'not set') + '</div></div>' +
      '<div style="text-align:right"><div style="font-weight:700">' + (c.monthly_surcharge ? formatMoney(c.monthly_surcharge) + '/mo' : 'No extra charge') + '</div>' + (c.active ? badge('Active', 'success') : badge('Inactive', 'default')) + '</div>' +
      '<div style="display:flex;gap:6px">' +
        '<label class="toggle"><input type="checkbox" ' + (c.active ? 'checked' : '') + ' onchange="window.__toggleConfig(\'' + c.id + '\',this.checked)"/><span class="toggle-slider"></span></label>' +
        '<button class="btn ghost sm" style="color:var(--error)" onclick="window.__deleteConfig(\'' + c.id + '\')">Delete</button>' +
      '</div></div>').join('') + '</div>');
  }

  window.__openAddConfig = () => {
    openModal('Add AI Agent',
      '<div class="form-row cols-2">' +
        '<div class="form-group"><label class="form-label">Label</label><input class="form-input" id="ac-label" placeholder="e.g. WhatsApp Receptionist"/></div>' +
        '<div class="form-group"><label class="form-label">Agent Role</label><select class="form-select" id="ac-role"><option value="receptionist">Receptionist</option><option value="concierge">Concierge</option><option value="support">Support</option></select></div>' +
        '<div class="form-group"><label class="form-label">Provider</label><select class="form-select" id="ac-provider">' + state.providers.map(p => '<option value="' + p + '">' + (AI_PROVIDER_LABELS[p] || p) + '</option>').join('') + '</select></div>' +
        '<div class="form-group"><label class="form-label">Model</label><input class="form-input" id="ac-model" placeholder="e.g. gpt-4o-mini, qwen-turbo…"/></div>' +
        '<div class="form-group" style="grid-column:1/-1"><label class="form-label">API Key</label><input class="form-input" type="password" id="ac-key" placeholder="sk-…"/></div>' +
        '<div class="form-group"><label class="form-label">Monthly Surcharge to Hotel ($)</label><input class="form-input" type="number" min="0" id="ac-surcharge" value="0"/></div>' +
      '</div>' +
      '<p style="font-size:11px;color:var(--text3)">This saves your provider choice and credentials for this agent role. Wiring it into a live conversation is a separate integration step handled by your developer.</p>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn primary" onclick="window.__addConfig()">Save Configuration</button>'
    );
  };
  window.__addConfig = async () => {
    const label = document.getElementById('ac-label').value.trim();
    if (!label) { toast('Label is required', 'error'); return; }
    try {
      await API.post('/api/ai-config', {
        label, agentRole: document.getElementById('ac-role').value, provider: document.getElementById('ac-provider').value,
        model: document.getElementById('ac-model').value.trim(), apiKey: document.getElementById('ac-key').value.trim(),
        monthlySurcharge: Number(document.getElementById('ac-surcharge').value || 0),
      });
      toast('AI agent configured', 'success'); closeModal(); await load();
    } catch (err) { toast(err.message, 'error'); }
  };
  window.__toggleConfig = async (id, val) => {
    try { await API.patch('/api/ai-config/' + id, { active: val }); toast(val ? 'Agent activated' : 'Agent deactivated', val ? 'success' : 'warn'); await load(); }
    catch (err) { toast(err.message, 'error'); }
  };
  window.__deleteConfig = (id) => {
    confirmAction('Delete this AI configuration?', async () => {
      try { await API.del('/api/ai-config/' + id); toast('Configuration deleted', 'warn'); await load(); }
      catch (err) { toast(err.message, 'error'); }
    });
  };

  load();
  return wrap;
};
