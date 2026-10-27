// public/js/ws-client.js
// Connects to the server's WebSocket endpoint for real-time tenant events.
// Auto-reconnects with backoff, refreshing the access token when it expires
// (access tokens are short-lived; a WS handshake with a stale one is rejected
// by the server with 4001 before the connection opens).
// Exposes WSClient.on(type, handler).

const WSClient = (() => {
  let socket = null;
  let reconnectDelay = 1000;
  const handlers = {};
  let accessTokenGetter = () => null;
  let backoffTimer = null;
  let stopped = true; // true when deliberately closed (logout / session gone)

  function setTokenGetter(fn) { accessTokenGetter = fn; }

  // Ask the server for a fresh access token via the httpOnly refresh cookie.
  // Returns true on success.
  //
  // This used to keep its OWN fetch + in-flight flag. So did api.js,
  // auth.js and offline.js — and because the refresh cookie is single-use,
  // two of them firing in the same instant made the server revoke every
  // session for the user ("you have been logged out again"). Everyone now
  // funnels through API.refreshSession(), which dedupes within the tab and
  // takes an exclusive Web Lock across tabs.
  async function refreshAccessToken() {
    if (typeof API === 'undefined' || !API.refreshSession) return false;
    try {
      const r = await API.refreshSession();
      return !!(r && r.status === 'ok');
    } catch (e) {
      return false;
    }
  }

  function connect() {
    if (stopped) return;
    const token = accessTokenGetter();
    if (!token) { scheduleReconnect(); return; }

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
    socket.onclose = (event) => {
      socket = null;
      setStatus('error');
      if (stopped) return;
      // 4001 = Unauthorized / expired token (server closes before open).
      // Refresh the token first, then retry — otherwise a long-lived tab just
      // spams the server with doomed handshakes (the "Access token has expired"
      // log flood) while never actually recovering.
      if (event && event.code === 4001) {
        refreshAccessToken().then((ok) => {
          if (stopped) return;
          if (ok) {
            reconnectDelay = 1000; // auth fixed — reconnect promptly
            connect();
          } else {
            setStatus('error');
            scheduleReconnect(); // keep trying slowly; cookie may recover
          }
        });
        return;
      }
      scheduleReconnect();
    };
    socket.onerror = () => { setStatus('error'); };
  }

  function scheduleReconnect() {
    if (stopped) return;
    if (backoffTimer) return; // one timer at a time
    backoffTimer = setTimeout(() => {
      backoffTimer = noMoreTimer;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 15000);
  }

  function noMoreTimer() { backoffTimer = null; }

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
    stopped = false;
    if (socket) { try { socket.close(); } catch (e) { /* noop */ } socket = null; }
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    reconnectDelay = 1000;
    connect();
  }

  // Deliberate stop (logout, session teardown): close the socket and make sure
  // no reconnect timer resurrects it afterwards.
  function disconnect() {
    stopped = true;
    if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
    if (socket) { try { socket.close(); } catch (e) { /* noop */ } socket = null; }
    setStatus('error');
  }

  return { connect, on, setTokenGetter, reconnectWithNewTenant, disconnect };
})();
