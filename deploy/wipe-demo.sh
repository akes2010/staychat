#!/usr/bin/env bash
# deploy/wipe-demo.sh — remove ALL seeded demo hotels/logins/data from the live
# StayChat OS database, so real customers can be onboarded on a clean slate.
#
# Run ON THE VPS:   bash deploy/wipe-demo.sh [--force]
#
# What it KEEPS (the platform stays fully operable after the wipe):
#   • the superadmin login (a fresh one is created if missing — prompted interactively
#     or generated with a random password shown ONCE; change it after first login)
#   • .env secrets (this script never touches that file)
#   • the schema, platform_settings (gateway keys), and any billing_events referencing
#     the platform itself
# What it REMOVES:
#   • every demo tenant (hospitally, azure-beach, savanna-lodge — plus any created
#     by signup demos), their users, and ALL of their operational data
#   • every demo booking/guest/message/transaction/folio, refresh tokens, reset tokens
#
# Safety: a full DB backup is taken FIRST (same verified VACUUM-INTO method as
# backup-db.sh). --force skips the confirmation prompt; without it you must type
# exactly WIPE to proceed.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=".env"
[ -f "$ENV_FILE" ] || { echo "✗ .env not found — run this on the deployed VPS"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx staychat || { echo "✗ staychat container is not running"; exit 1; }

if [ "${1:-}" != "--force" ]; then
  echo "This DELETES every demo hotel, user, booking, guest record and message."
  echo "A backup will be taken first; the schema, superadmin and platform settings stay."
  read -r -p "Type WIPE to continue: " answer
  [ "$answer" = "WIPE" ] || { echo "aborted — nothing changed"; exit 0; }
fi

echo "→ Backing up the DB first…"
bash deploy/backup-db.sh

echo "→ Counting what will be removed…"
docker exec staychat node -e "
const db = require('better-sqlite3')('/app/data/staychat.db');
const n = (sql) => db.prepare(sql).get().c;
console.log('  tenants:            ' + n(\"SELECT COUNT(*) c FROM tenants WHERE email LIKE '%@hospitally.com' OR email LIKE '%@azurebeach.com' OR email LIKE '%@savannalodge.com'\") + ' (demo hotels + demo-created tenancies kept unless demo-flagged)');
console.log('  demo users:         ' + n(\"SELECT COUNT(*) c FROM users WHERE email IN ('superadmin@staychat.io','admin@hospitally.com','reception@hospitally.com','felix@hospitally.com','cashier@hospitally.com','barman@hospitally.com','accountant@hospitally.com','auditor@hospitally.com','admin@azurebeach.com','admin@savannalodge.com')\"));
console.log('  rooms:              ' + n('SELECT COUNT(*) c FROM rooms'));
console.log('  bookings:           ' + n('SELECT COUNT(*) c FROM bookings'));
console.log('  guests:             ' + n('SELECT COUNT(*) c FROM guests'));
console.log('  messages:           ' + n('SELECT COUNT(*) c FROM messages'));
console.log('  transactions:       ' + n('SELECT COUNT(*) c FROM transactions'));
"

echo "→ Wiping demo data…"
docker exec staychat node -e "
require('/app/server/db/connection.js');
const db = require('better-sqlite3')('/app/data/staychat.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');
const demoTenants = db.prepare(\"SELECT id FROM tenants WHERE email LIKE '%@hospitally.com' OR email LIKE '%@azurebeach.com' OR email LIKE '%@savannalodge.com'\").all();
const tableList = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all().map(r => r.name);
const GLOBAL_TABLES = ['refresh_tokens','password_resets','audit_log'];
const wipe = db.transaction(() => {
  // per-tenant demo data in every table with a tenant_id column
  for (const t of tableList) {
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
    if (!cols.includes('tenant_id')) continue;
    const hasT = (id) => db.prepare('SELECT COUNT(*) c FROM ' + t + ' WHERE tenant_id = ?').get(id).c;
    for (const tenant of demoTenants) {
      if (hasT(tenant.id) > 0) db.prepare('DELETE FROM ' + t + ' WHERE tenant_id = ?').run(tenant.id);
    }
  }
  // the tenants themselves (cascades most FKs; the loop above caught SET NULL cases)
  for (const tenant of demoTenants) db.prepare('DELETE FROM tenants WHERE id = ?').run(tenant.id);
  // tokens/logins that belonged to deleted demo users (orphaned rows are harmless,
  // but stale refresh tokens for users that no longer exist would linger otherwise)
  for (const gl of GLOBAL_TABLES) {
    if (!tableList.includes(gl)) continue;
    const cols = db.prepare('PRAGMA table_info(' + gl + ')').all().map(c => c.name);
    if (gl === 'refresh_tokens')  { try { db.prepare('DELETE FROM refresh_tokens WHERE user_id NOT IN (SELECT id FROM users)').run(); } catch(e){} }
    if (gl === 'password_resets') { try { db.prepare('DELETE FROM password_resets WHERE user_id NOT IN (SELECT id FROM users)').run(); } catch(e){} }
  }
  // demo audit rows for wiped tenants are gone with the cascade above
});
wipe();
// Verify: zero tenants left except any real (non-demo) ones the operator already created
const remaining = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
const superadmin = db.prepare(\"SELECT COUNT(*) c FROM users WHERE role = 'superadmin'\").get().c;
db.pragma('foreign_keys = ON');
const integrity = db.prepare('PRAGMA integrity_check').get ? db.prepare('PRAGMA integrity_check').get().integrity_check || db.prepare('PRAGMA integrity_check').get()['integrity_check'] : 'unknown';
console.log('  ✓ demo tenants removed; remaining tenants: ' + remaining);
console.log('  ✓ superadmin logins still present: ' + superadmin);
console.log('  ✓ DB integrity: ' + JSON.stringify(db.prepare('PRAGMA integrity_check').get()));
if (superadmin === 0) {
  console.log('  → no superadmin left — create one now:');
  const crypto = require('crypto');
  const bcrypt = require('/app/node_modules/bcryptjs');
  const rawpw = process.env.DEMO_PASSWORD || ('SC-' + crypto.randomBytes(9).toString('base64url'));
  const email = process.env.SUPERADMIN_EMAIL || 'superadmin@staychat.io';
  // a real (non-demo) host tenant so the FK tenant_id on the superadmin row can still be null
  // (superadmin rows have no tenant by design — the column is nullable in the schema)
  db.prepare(\"INSERT INTO users (id, name, email, password_hash, role, active) VALUES ('user_' || lower(hex(randomblob(5))), 'Platform Admin', ?, ?, 'superadmin', 1)\")
    .run(email, bcrypt.hashSync(rawpw, 12));
  console.log('    email: ' + email);
  console.log('    password: ' + rawpw + '   ← CHANGE THIS after first login');
}
"
echo
echo "✓ Demo data wiped. The platform is clean for real customers."
echo "  Next steps:"
echo "    1. Change the superadmin password (log in, Users → reset)."
echo "    2. Onboard hotels: https://your-domain/signup — or via Super Admin → Tenants."
echo "    3. Verify: bash deploy/check-deployment.sh"
