// scripts/lib/free-port.js — OS-assigned free TCP port for a throwaway
// Chromium DevTools endpoint.
//
// The browser suites used FIXED DevTools ports (9229 was shared by five of
// them) plus a "busy-wait" pre-check that gave up silently after 5 seconds —
// if the previous suite's chromium lingered, the next suite attached to the
// STALE browser and every assertion ran against the wrong page. Handing out
// a fresh free port per run removes the collision class entirely: the only
// process that can answer on it is the chromium we just spawned.
'use strict';

const net = require('net');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
