// public/js/pages/inbox.js
window.PAGES = window.PAGES || {};

PAGES.inbox = function () {
  const wrap = el('div', 'fa');
  const state = { conversations: [], selectedId: null, messages: [] };

  async function load() {
    wrap.innerHTML = loaderHTML('Loading inbox…');
    try {
      state.conversations = await API.get('/api/inbox/conversations');
      if (!state.selectedId && state.conversations.length) state.selectedId = state.conversations[0].id;
      await loadMessages();
      render();
    } catch (err) {
      wrap.innerHTML = errorStateHTML(err.message, 'navigate(\'inbox\')');
    }
  }

  async function loadMessages() {
    if (!state.selectedId) { state.messages = []; return; }
    const data = await API.get('/api/inbox/conversations/' + state.selectedId + '/messages');
    state.messages = data.messages;
  }

  function render() {
    const active = state.conversations.find(c => c.id === state.selectedId);
    wrap.innerHTML = '' +
    '<div class="page-header"><div class="page-header-left"><h1>WhatsApp Inbox</h1><p>' + state.conversations.length + ' conversations &middot; AI-powered responses</p></div>' +
      '<button class="btn primary" onclick="window.__openNewChat()">+ New Conversation</button></div>' +
    '<div class="chat-layout" style="height:calc(100dvh - 180px)">' +
      '<div class="chat-list">' +
        '<div class="chat-list-header"><div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
          '<div class="pulse-dot" style="width:7px;height:7px;border-radius:99px;background:var(--a)"></div><span style="font-weight:700;font-size:14px">Inbox</span>' +
          '<span style="margin-left:auto;background:var(--a);color:var(--p-dark);border-radius:99px;font-size:10px;font-weight:700;padding:1px 7px">' + state.conversations.length + '</span></div>' +
          '<div class="chat-search"><span>🔍</span><input placeholder="Search conversations…"/></div></div>' +
        '<div class="chat-items">' +
          (state.conversations.length === 0 ? '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">No conversations yet</div>' : '') +
          state.conversations.map(c => {
            const initials = escapeHtml(c.guest_name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase());
            return '<div class="chat-item' + (state.selectedId === c.id ? ' active' : '') + '" onclick="window.__selectChat(\'' + c.id + '\')">' +
            '<div class="chat-av">' + initials + (c.online ? '<div class="online-dot"></div>' : '') + '</div>' +
            '<div class="chat-item-info"><div class="chat-item-name">' + escapeHtml(c.guest_name) + '</div><div class="chat-item-msg">' + escapeHtml(c.last_message || 'No messages') + '</div></div>' +
            '<div class="chat-item-meta"><span class="chat-item-time">' + timeAgo(c.last_message_at) + '</span>' + (c.unread_count > 0 ? '<span class="chat-unread">' + c.unread_count + '</span>' : '') + '</div></div>';
          }).join('') +
        '</div></div>' +
      '<div class="chat-window">' +
        (active ? '' +
          '<div class="chat-win-header">' +
            '<div class="chat-av" style="background:var(--surface2);color:var(--p);width:38px;height:38px;border:2px solid rgba(255,255,255,.3)">' + escapeHtml(active.guest_name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase()) + '</div>' +
            '<div class="chat-win-info"><div class="chat-win-name">' + escapeHtml(active.guest_name) + '</div><div class="chat-win-status">' + (active.room_number ? 'Room ' + escapeHtml(active.room_number) + ' &middot; ' : '') + (active.online ? 'Online' : 'Last seen recently') + '</div></div>' +
            '<div style="margin-left:auto;display:flex;gap:8px">' +
              '<button class="icon-btn" style="border-color:rgba(255,255,255,.2);color:#fff" onclick="toast(\'Calling ' + escapeJsInAttr(active.guest_name) + '…\',\'info\')">📞</button>' +
              '<button class="icon-btn" style="border-color:rgba(255,255,255,.2);color:#fff" title="Simulate guest reply (demo)" onclick="window.__openSimulateGuest()">🧪</button>' +
            '</div></div>' +
          '<div class="chat-messages" id="chat-msgs"><div class="chat-date-sep">TODAY</div>' +
            state.messages.map(m => '<div class="msg-bubble ' + (m.sender === 'guest' ? 'incoming' : 'outgoing') + '">' +
              (m.sender === 'ai' ? '<div class="msg-ai-label">AI Receptionist</div>' : '') +
              (m.sender === 'staff' ? '<div class="msg-ai-label" style="color:var(--info)">Staff</div>' : '') +
              escapeHtml(m.body) +
              '<div class="msg-meta"><span class="msg-time">' + fmtTime(m.created_at) + '</span>' + (m.sender !== 'guest' ? '<span class="msg-tick">✓✓</span>' : '') + '</div></div>').join('') +
          '</div>' +
          '<div class="chat-input-bar"><div class="chat-input-wrap"><span style="cursor:pointer;font-size:18px">😊</span>' +
              '<input id="chat-input" placeholder="Type a message…" onkeydown="if(event.key===\'Enter\')window.__sendChatMsg()"/>' +
              '<span style="cursor:pointer;font-size:18px" onclick="toast(\'Attachments require WhatsApp Media API setup\',\'info\')">📎</span></div>' +
            '<button class="chat-send-btn" onclick="window.__sendChatMsg()">➤</button></div>'
        : '<div class="empty-state" style="margin:auto"><div class="empty-state-icon">💬</div><div class="empty-state-title">Select a conversation</div></div>') +
      '</div>' +
    '</div>';

    setTimeout(() => { const cm = document.getElementById('chat-msgs'); if (cm) cm.scrollTop = cm.scrollHeight; }, 50);
  }

  window.__selectChat = async (id) => { state.selectedId = id; await loadMessages(); render(); };

  window.__sendChatMsg = async () => {
    const inp = document.getElementById('chat-input');
    const txt = inp && inp.value ? inp.value.trim() : '';
    if (!txt || !state.selectedId) return;
    inp.value = '';
    try {
      await API.post('/api/inbox/conversations/' + state.selectedId + '/messages', { body: txt });
      await loadMessages();
      render();
    } catch (err) { toast(err.message, 'error'); }
  };

  window.__openNewChat = () => {
    openModal('New Conversation',
      '<div class="form-row cols-2" style="margin-bottom:14px">' +
        '<div class="form-group"><label class="form-label">Guest Name</label><input class="form-input" id="nc-name" placeholder="e.g. Jane Doe"/></div>' +
        '<div class="form-group"><label class="form-label">WhatsApp Phone</label><input class="form-input" id="nc-phone" placeholder="+1 555 0000"/></div></div>' +
      '<div class="form-group" style="margin-bottom:14px"><label class="form-label">Room (optional)</label><input class="form-input" id="nc-room" placeholder="e.g. 204"/></div>' +
      '<div class="form-group"><label class="form-label">First Message</label><textarea class="form-textarea" id="nc-msg" placeholder="Type your message…"></textarea></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn accent" onclick="window.__startNewChat()">Start Conversation</button>'
    );
  };
  window.__startNewChat = async () => {
    const guestName = document.getElementById('nc-name').value.trim();
    const guestPhone = document.getElementById('nc-phone').value.trim();
    if (!guestName || !guestPhone) { toast('Guest name and phone are required', 'error'); return; }
    try {
      const conv = await API.post('/api/inbox/conversations', {
        guestName, guestPhone, roomNumber: document.getElementById('nc-room').value || null, firstMessage: document.getElementById('nc-msg').value || null,
      });
      toast('Conversation started', 'success'); closeModal();
      state.selectedId = conv.id;
      await load();
    } catch (err) { toast(err.message, 'error'); }
  };

  // Demo helper: simulate an incoming guest WhatsApp message + AI reply (since this
  // sandbox has no real WhatsApp number connected). In production this flow is
  // triggered automatically by server/routes/webhooks.js when Meta delivers a message.
  window.__openSimulateGuest = () => {
    openModal('Simulate Guest Message (Demo)',
      '<p style="font-size:13px;color:var(--text3);margin-bottom:14px">This simulates what happens when a real WhatsApp message arrives via the webhook — the AI receptionist will generate a live reply.</p>' +
      '<div class="form-group"><label class="form-label">Guest says…</label><textarea class="form-textarea" id="sim-msg" placeholder="e.g. What time is checkout?"></textarea></div>',
      '<button class="btn outline" onclick="closeModal()">Cancel</button><button class="btn accent" onclick="window.__sendSimulatedGuestMsg()">Send &amp; Trigger AI</button>'
    );
  };
  window.__sendSimulatedGuestMsg = async () => {
    const txt = document.getElementById('sim-msg').value.trim();
    if (!txt || !state.selectedId) return;
    try {
      await API.post('/api/inbox/conversations/' + state.selectedId + '/simulate-guest-message', { body: txt });
      closeModal();
      await loadMessages();
      render();
    } catch (err) { toast(err.message, 'error'); }
  };

  load();

  // Live updates
  WSClient.on('message.created', (payload) => {
    if (payload.conversationId === state.selectedId) {
      state.messages.push({ ...payload.message, aiGenerated: !!payload.message.ai_generated });
      render();
    }
    // Refresh conversation list previews regardless
    API.get('/api/inbox/conversations').then(cs => { state.conversations = cs; if (!document.getElementById('chat-input')) render(); }).catch(() => {});
  });

  return wrap;
};
