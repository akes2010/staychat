#!/usr/bin/env bash
# diagnose-and-fix.sh — run from inside the staychat-os project folder.
# Rebuilds the DB schema, force-reseeds demo data, then proves the
# cashier/barman accounts exist by querying the database directly.
set -e

echo "── Where am I? ──────────────────────────────────────────"
pwd
echo

echo "── Which database file will the app actually use? ──────"
node -e "
const path = require('path');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
console.log('DATA_DIR      =', DATA_DIR);
console.log('DB file       =', path.join(DATA_DIR, 'staychat.db'));
console.log('File exists?  =', require('fs').existsSync(path.join(DATA_DIR, 'staychat.db')));
"
echo

echo "── Step 1: migrate ─────────────────────────────────────"
npm run migrate
echo

echo "── Step 2: force reseed (wipes and recreates demo data) ─"
FORCE_SEED=1 npm run seed
echo

echo "── Step 3: verify cashier/barman actually exist in the DB ─"
node -e "
const db = require('./server/db/connection');
const rows = db.prepare(\"SELECT email, role, active FROM users WHERE role IN ('cashier','barman')\").all();
console.log(JSON.stringify(rows, null, 2));
if (rows.length === 2) {
  console.log('✅ PASS — both accounts exist.');
} else {
  console.log('❌ FAIL — expected 2 rows, got', rows.length, '. Something is still wrong — send me this full output.');
  process.exit(1);
}
"
echo
echo "If you see PASS above, log in with:"
echo "  cashier@hospitally.com / Demo@123456"
echo "  barman@hospitally.com  / Demo@123456"
echo
echo "Now starting the server..."
npm start
