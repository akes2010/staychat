// server/db/connection.js
// SQLite connection with performance optimizations
// File-based, zero-config, deployable anywhere.
// To migrate to PostgreSQL later: swap this file for a `pg` Pool and
// update the few raw-SQL spots that use SQLite-specific syntax.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'staychat.db');

// Create database connection with optimized settings
const db = new Database(DB_PATH, {
  // Enable WAL mode for better concurrent read performance
  // WAL mode allows reads to proceed without blocking writes
  verbose: process.env.NODE_ENV === 'development' ? console.log : null,
});

// Performance optimizations
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL'); // Faster writes, still safe with WAL
db.pragma('cache_size = -64000'); // 64MB cache (negative = KB)
db.pragma('temp_store = MEMORY'); // Temp tables in memory
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks

// ── Prepared-statement cache ─────────────────────────────────────────────────
// better-sqlite3 compiles every db.prepare(sql) from scratch (parse + codegen
// ≈9µs measured vs ≈3µs for a cached statement). Route handlers prepare on
// EVERY request — dozens of times — so caching by SQL text reclaims ~3× of
// that cost. Bounded (FIFO) because a few call sites build SQL dynamically
// (`IN (${ids…})`), which would otherwise grow the cache forever.
//
// SAFETY: statements are only reused after .get()/.all()/.run() — all of which
// fully finish before returning — so a shared statement can never be re-entered.
// Do NOT hold a statement across `.iterate()` (no call site does today).
const STMT_CACHE_MAX = 1000;
const stmtCache = new Map();
const nativePrepare = db.prepare.bind(db);
db.prepare = function prepareCached(sql) {
  const hit = stmtCache.get(sql);
  if (hit !== undefined) {
    // FIFO refresh: delete+set moves the key to the back for eviction order.
    stmtCache.delete(sql);
    stmtCache.set(sql, hit);
    return hit;
  }
  const stmt = nativePrepare(sql); // throws for bad SQL — never cached
  if (stmtCache.size >= STMT_CACHE_MAX) {
    stmtCache.delete(stmtCache.keys().next().value);
  }
  stmtCache.set(sql, stmt);
  return stmt;
};

// Helper for getting a count with error handling
function safeCount(stmt) {
  try {
    return stmt.get().c || 0;
  } catch {
    return 0;
  }
}

// Convenience wrapper: run `fn` inside a transaction immediately (with automatic
// rollback on error). NOTE: this is exported as `runTransaction`, NOT `transaction`
// — assigning it to `module.exports.transaction` would create an own property on the
// db instance that shadows better-sqlite3's native `db.transaction` prototype method,
// turning `db.transaction(fn)` into infinite self-recursion. Callers that need the
// native builder (`const t = db.transaction(fn); t();`) rely on that method staying intact.
function runTransaction(fn) {
  return db.transaction(fn)();
}

// Execute a query. `busy_timeout` (set above) already makes better-sqlite3 wait
// natively for locks, so we do NOT spin-wait on the JS event loop here — that
// would freeze the entire process. SQLITE_BUSY after the native timeout is a
// genuine error and is propagated to the caller.
function execWithRetry(sql, params = []) {
  const stmt = db.prepare(sql);
  return params.length > 0 ? stmt.all(...params) : stmt.all();
}

// Health check function
function checkHealth() {
  try {
    const result = db.prepare('SELECT 1 as ok').get();
    const stats = db.prepare('PRAGMA database_list').all();
    return { ok: true, database: stats[0]?.name || 'main', path: DB_PATH };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Graceful shutdown. Capture the native close now: `module.exports.close = closeDb`
// below assigns an own `close` property on the db instance that shadows better-sqlite3's
// native prototype method, so calling `db.close()` in here would recurse into this
// wrapper forever. `nativeClose` holds the real method, bound to the instance.
const nativeClose = db.close.bind(db);
function closeDb() {
  try {
    // Check for open transactions
    db.exec('PRAGMA optimize'); // Final optimization before close
    stmtCache.clear(); // cached statements are finalized by close — drop refs first
    nativeClose();
    return true;
  } catch (err) {
    console.error('Error closing database:', err);
    return false;
  }
}

module.exports = db;
module.exports.runTransaction = runTransaction;
module.exports.execWithRetry = execWithRetry;
module.exports.checkHealth = checkHealth;
module.exports.safeCount = safeCount;
module.exports.close = closeDb;
