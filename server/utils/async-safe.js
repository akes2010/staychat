// server/utils/async-safe.js
// Makes Express 4 forward rejected promises from async route handlers to the
// error handler — instead of letting them become `unhandledRejection`, which
// since Node 15 CRASHES THE WHOLE PROCESS.
//
// Several routes declare `async (req, res) => {...}` without a wrapping
// try/catch (wifi provisioning, booking check-in/out, inbox simulation,
// messaging blasts, integration tests…). One rejected `await` in any of them
// — a provider timeout, a malformed row — would previously take down every
// session of every tenant on the box. With this patch the rejection goes to
// next(err) → the JSON error handler → a 500 for THAT request only.
//
// This mirrors what Express 5 and the `express-async-errors` package do
// (patch the Layer dispatch hook), done inline so we stay dependency-free and
// pinned to Express 4. require() this BEFORE any ./routes/* module loads.
'use strict';

let patched = false;

try {
  const Layer = require('express/lib/router/layer');
  const proto = Layer && Layer.prototype;

  if (proto && !proto.__staychatAsyncSafe) {
    proto.handle_request = function handleRequest(req, res, next) {
      const fn = this.handle;
      if (fn.length > 3) return next(); // error middleware — left alone
      try {
        const ret = fn(req, res, next);
        if (ret && typeof ret.then === 'function') {
          ret.then(undefined, next); // async rejection → Express error handler
        }
      } catch (err) {
        next(err);
      }
    };
    proto.__staychatAsyncSafe = true;
    patched = true;
  } else if (proto && proto.__staychatAsyncSafe) {
    patched = true; // already installed (module re-required by tests)
  }

  if (!patched) {
    console.warn('⚠️ async-safe: unexpected express Layer shape — async route errors NOT captured.');
  }
} catch (e) {
  console.warn('⚠️ async-safe: could not install async route error capture (' + e.message + ')');
}

// ── Process-level safety nets ──────────────────────────────────────────
// Whatever still escapes the Layer patch (timers, callbacks outside the
// request path) must not take down EVERY tenant's live sessions: log it with
// context and keep serving. Request-scoped async errors never reach here —
// they go to the JSON error handler above.
if (!process.__staychatSafetyNets) {
  process.__staychatSafetyNets = true;
  const isProd = process.env.NODE_ENV === 'production';
  process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), event: 'unhandledRejection',
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error && !isProd ? reason.stack : undefined,
    }));
  });
  process.on('uncaughtException', (err) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(), event: 'uncaughtException',
      error: err && err.message, stack: isProd ? undefined : err && err.stack,
    }));
  });
}

module.exports = { patched };
