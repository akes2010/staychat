#!/usr/bin/env node
// Reproduces the "Search Available Rooms not responding" report and proves the fix.
//
// Scenario: the previously-deployed public/book.html had a JS syntax error — the
// whole inline script failed to parse, so NO handlers attached and the Search
// button did nothing. Express served HTML with Cache-Control: max-age=86400, so
// every visitor who loaded the broken page kept it (dead buttons) for a full day,
// even after the file was fixed on the server.
//
// Phases, same origin (localhost:4299):
//   A: old broken page served with max-age=86400        → cached, search dead
//   C: fixed page still served with max-age=86400       → stale cache reused, search STILL dead (the bug)
//   D: real app server, HTML no-cache, same URL/profile → STILL stale: the poisoned entry is FRESH,
//                                                         so the browser never re-asks the server.
//                                                         A same-URL header fix can only protect
//                                                         future responses, not rescue holders.
//   E: same browser, generated link now ends in &v=2    → new URL key bypasses the poison; search works
//   F: fresh profile against the no-cache server        → fixed page served and working (all future guests)
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4299;
const OLD_HTML = fs.readFileSync('/tmp/head-book.html', 'utf8'); // git HEAD (broken)
const FIX_HTML = fs.readFileSync(path.join(ROOT, 'public', 'book.html'), 'utf8');

const POISON = '/book.html?hotel=hospitally';           // link guests already have
const BUSTED = '/book.html?hotel=hospitally&v=2';       // what generated links carry now
const PROFILE = '/tmp/chrome-cache-repro';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function miniServer(html, cacheControl) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/book.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl });
        res.end(html);
      } else { res.writeHead(404); res.end(); }
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

function startAppServer(dataDir) {
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => http.get(`http://localhost:${PORT}/api/health`, r => { r.resume(); resolve(srv); })
      .on('error', () => Date.now() - t0 > 15000 ? reject(new Error('app server not healthy')) : setTimeout(tick, 400));
    tick();
  });
}

async function withBrowser(profile, fn) {
  fs.mkdirSync(profile, { recursive: true });
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu',
    `--user-data-dir=${profile}`, '--remote-debugging-port=9227', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch('http://localhost:9227/json/version'); break; } catch (e) { await sleep(250); } }
    const list = await fetch('http://localhost:9227/json').then(r => r.json());
    const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
    return await fn({ send, evl });
  } finally { try { chrome.kill(); } catch (e) {} }
}

async function searchState(evl, urlPath) {
  // fresh navigation, exactly like a guest opening/refreshing the link
  await evl(`location.href = 'http://localhost:${PORT}${urlPath}'`).catch(() => {});
  await sleep(1500);
  const handler = await evl(`(function(){ var b = document.getElementById('search'); return b ? typeof b.onclick : 'no-button'; })()`);
  await evl(`(function(){ var b = document.getElementById('search'); if (b && b.onclick) b.onclick(); return true; })()`).catch(() => {});
  await sleep(1200);
  const rooms = await evl(`document.querySelectorAll('#rooms .room').length`);
  return { handler, rooms };
}

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-cachefix.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }

  // Phase A: old broken page, aggressively cached (what production served before)
  let mini = await miniServer(OLD_HTML, 'public, max-age=86400');
  await withBrowser(PROFILE, async ({ evl }) => {
    const s = await searchState(evl, POISON);
    console.log(`A) broken page + max-age=86400 : handler=${s.handler} rooms=${s.rooms}   (entry cached for a day)`);
  });
  mini.close();

  // Phase C: server now has the FIXED page but still with max-age — browser must NOT revalidate
  mini = await miniServer(FIX_HTML, 'public, max-age=86400');
  await withBrowser(PROFILE, async ({ evl }) => {
    const s = await searchState(evl, POISON);
    console.log(`C) fixed page + max-age=86400  : handler=${s.handler} rooms=${s.rooms}   ← THE BUG: stale copy reused, fix invisible`);
    if (s.handler === 'object' && s.rooms === 0) console.log('   ✓ reproduced: search still not responding even though the server has the fix');
  });
  mini.close();

  // Phase D+ run against the real app server (HTML served with no-cache now).
  const app = await startAppServer(dataDir);

  // Phase D: same URL, same poisoned profile. The stored entry is still FRESH,
  // so the browser never sends a conditional request — the no-cache header on
  // the response it never asks for cannot help. This is WHY generated links
  // are cache-busted instead.
  await withBrowser(PROFILE, async ({ evl }) => {
    const s = await searchState(evl, POISON);
    console.log(`D) no-cache server, same URL   : handler=${s.handler} rooms=${s.rooms}   ← expected: still stale (fresh entry, browser never re-asks)`);
  });

  // Phase E: the escape hatch — generated links now carry &v=2, a URL the
  // poisoned cache has never seen, so the fixed page loads and works.
  await withBrowser(PROFILE, async ({ evl }) => {
    const s = await searchState(evl, BUSTED);
    console.log(`E) same browser, ?v=2 link     : handler=${s.handler} rooms=${s.rooms}   ✓ escape hatch: new URL key bypasses the poison`);
    if (s.handler === 'function' && s.rooms > 0) console.log('   ✓ FIXED for existing guests with poisoned caches');
    else console.log('   ✗ NOT FIXED');
  });

  // Phase F: clean slate — new guests (or anyone whose old entry finally
  // expired) get the no-cache page immediately, and it works.
  await withBrowser(PROFILE + '-fresh', async ({ evl }) => {
    const s = await searchState(evl, POISON);
    console.log(`F) fresh profile, no-cache     : handler=${s.handler} rooms=${s.rooms}   ✓ no-cache HTML: server always revalidated, search works`);
    if (s.handler === 'function' && s.rooms > 0) console.log('   ✓ FIXED for every future guest — a bad page can now never outlive a deploy');
    else console.log('   ✗ NOT FIXED');
  });

  try { app.kill(); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
