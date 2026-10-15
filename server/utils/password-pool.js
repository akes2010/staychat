// server/utils/password-pool.js
// Off-main-thread bcrypt for route handlers.
//
// WHY: bcryptjs is pure JavaScript — ONE cost-12 compare/hash costs ~350ms of
// BLOCKED event loop on this hardware (measured). Express handlers run on the
// single request thread, so a shift-start login burst of a few hundred staff
// would previously freeze EVERY request of EVERY tenant for minutes
// (health checks, API calls, WebSocket heartbeats — all queued behind
// back-to-back bcrypt computations). The async bcryptjs API does NOT help:
// it still computes synchronously on this thread, just one tick later.
//
// Fix: a small pool of worker_threads (real OS threads) runs hash/compare in
// parallel; the request thread only awaits a promise. Hash VALUES are
// unchanged — existing password hashes keep verifying (same bcrypt cost-12
// format), so this is a drop-in with no migration.
//
// API (promises):
//   hashPassword(password, rounds)      → '$2b$…'
//   comparePassword(password, hash)     → boolean
//
// Tunables: BCRYPT_WORKERS (default: cpus-2 capped at 6, min 1).
'use strict';

const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'password-worker.js');
const WORKER_COUNT = (() => {
  const n = parseInt(process.env.BCRYPT_WORKERS, 10);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 32);
  return Math.max(1, Math.min(6, os.cpus().length - 2));
})();

/** @type {{w: Worker, busy: boolean, currentId: number|null, dead: boolean}[]} */
const workers = [];
const queue = [];               // {op, password, hash, rounds, deferred}
const pending = new Map();      // task id -> {resolve, reject}
let nextId = 1;
let poolStarted = false;

function makeWorker() {
  const w = new Worker(WORKER_PATH);
  const slot = { w, busy: false, currentId: null, dead: false };

  w.on('message', (msg) => {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error || 'password worker error'));
    }
    slot.busy = false;
    slot.currentId = null;
    // Idle workers must not keep a short-lived process (tests, scripts) alive;
    // pump() re-refs a worker the moment it gets its next task.
    if (queue.length === 0) slot.w.unref();
    pump();
  });
  w.on('error', (err) => failSlot(slot, err));
  w.on('exit', (code) => { if (!slot.dead) failSlot(slot, new Error('password worker exited unexpectedly (code ' + code + ')')); });
  return slot;
}

function failSlot(slot, err) {
  if (slot.dead) return;
  slot.dead = true;
  if (slot.currentId != null && pending.has(slot.currentId)) {
    const p = pending.get(slot.currentId);
    pending.delete(slot.currentId);
    p.reject(err);
  }
  try { slot.w.terminate(); } catch (e) { /* already gone */ }
  const idx = workers.indexOf(slot);
  const fresh = makeWorker();
  if (idx >= 0) workers[idx] = fresh; else workers.push(fresh);
  pump();
}

function pump() {
  for (const slot of workers) {
    if (slot.dead || slot.busy) continue;
    if (queue.length === 0) return;
    const task = queue.shift();
    const id = nextId++;
    pending.set(id, task.deferred);
    slot.busy = true;
    slot.currentId = id;
    slot.w.ref();
    slot.w.postMessage({ id, op: task.op, password: task.password, hash: task.hash, rounds: task.rounds });
    task.password = undefined;
    task.hash = undefined;
  }
}

function ensurePool() {
  if (poolStarted) return;
  poolStarted = true;
  for (let i = 0; i < WORKER_COUNT; i++) workers.push(makeWorker());
}

function run(op, fields) {
  ensurePool();
  return new Promise((resolve, reject) => {
    queue.push({ op, ...fields, deferred: { resolve, reject } });
    pump();
  });
}

function hashPassword(password, rounds = 12) {
  if (typeof password !== 'string') return Promise.reject(new Error('password must be a string'));
  return run('hash', { password, rounds });
}

function comparePassword(password, hash) {
  if (typeof password !== 'string' || typeof hash !== 'string') return Promise.resolve(false);
  return run('compare', { password, hash });
}

module.exports = { hashPassword, comparePassword, WORKER_COUNT };
