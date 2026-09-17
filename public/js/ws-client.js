// public/js/ws-client.js
// Connects to the server's WebSocket endpoint for real-time tenant events.
// Auto-reconnects with backoff. Exposes WSClient.on(type, handler).

const WSClient = (() => {
  let socket = null;
  let reconnectDelay = 1000;
  const handlers = {};
  let accessTokenGetter = () => null;

  function setTokenGetter(fn) { accessTokenGetter = fn; }

  function connect() {
    const token = accessTokenGetter();
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const tenantParam = (window.App && window.App.tenantId) ? `&tenantId=${encodeURIComponent(window.App.tenantId)}` : '';
    const url = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}${tenantParam}`;

    try {
      socket = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    socket.onopen = () => {
      reconnectDelay = 1000;
      setStatus('active');
    };
    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (handlers[msg.type]) handlers[msg.type].forEach(fn => fn(msg.payload));
      } catch (e) { /* ignore malformed frames */ }
    };
    socket.onclose = () => {
      setStatus('error');
      scheduleReconnect();
    };
    socket.onerror = () => { setStatus('error'); };
  }

  function scheduleReconnect() {
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  }

  function setStatus(state) {
    const el = document.getElementById('ws-status');
    if (!el) return;
    el.classList.remove('active', 'error');
    el.classList.add(state);
    el.title = state === 'active' ? 'Live updates connected' : 'Reconnecting...';
  }

  function on(type, handler) {
    if (!handlers[type]) handlers[type] = [];
    handlers[type].push(handler);
  }

  function reconnectWithNewTenant() {
    if (socket) socket.close();
    connect();
  }

  return { connect, on, setTokenGetter, reconnectWithNewTenant };
})();
