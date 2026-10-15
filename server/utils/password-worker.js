// server/utils/password-worker.js
// Worker-thread half of the bcrypt pool (see password-pool.js): runs the
// CPU-bound bcryptjs work OFF the request thread so a login burst can never
// freeze every other tenant's traffic.
'use strict';

const bcrypt = require('bcryptjs');
const { parentPort } = require('worker_threads');

if (!parentPort) throw new Error('password-worker.js must run as a worker thread');

parentPort.on('message', (msg) => {
  try {
    if (msg.op === 'hash') {
      parentPort.postMessage({ id: msg.id, ok: true, value: bcrypt.hashSync(msg.password, msg.rounds) });
    } else if (msg.op === 'compare') {
      parentPort.postMessage({ id: msg.id, ok: true, value: bcrypt.compareSync(msg.password, msg.hash) });
    } else {
      parentPort.postMessage({ id: msg.id, ok: false, error: 'Unknown op: ' + msg.op });
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: (e && e.message) || String(e) });
  }
});
