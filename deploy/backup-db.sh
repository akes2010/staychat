#!/usr/bin/env bash
# deploy/backup-db.sh — consistent SQLite backup of the running StayChat OS DB.
# Designed for cron. Retains BACKUP_KEEP days of snapshots in /opt/backups.
#
#   crontab line (daily at 03:17) — installed automatically by setup-vps.sh:
#     17 3 * * * /opt/staychat-os/deploy/backup-db.sh >> /var/log/staychat-backup.log 2>&1
#
# How it stays consistent: the app runs with WAL mode enabled, so copying the
# bare .db file mid-write could tear a transaction. Instead we run
# "VACUUM INTO" INSIDE the container via the app's own better-sqlite3 module
# (no sqlite3 CLI needed anywhere) — SQLite produces a single, compacted,
# fully consistent snapshot. Integrity of the snapshot is verified inside the
# container BEFORE it is copied out, so a bad run never replaces good backups.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
STAMP="$(date +%F-%H%M)"
TARGET="$BACKUP_DIR/staychat-$STAMP.db"

if ! docker ps --format '{{.Names}}' | grep -qx staychat; then
  echo "✗ $(date -Is) staychat container is not running — backup aborted"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Consistent snapshot + integrity check inside the container.
if ! docker exec staychat node -e "
const db = require('better-sqlite3')('/app/data/staychat.db');
db.exec(\"VACUUM INTO '/tmp/staychat-snapshot.db'\");
db.close();
const snap = require('better-sqlite3')('/tmp/staychat-snapshot.db');
const result = snap.pragma('integrity_check', { simple: true });
snap.close();
if (result !== 'ok') { console.error('integrity_check: ' + result); process.exit(1); }
"; then
  echo "✗ $(date -Is) snapshot or integrity check FAILED — old backups untouched"
  docker exec staychat rm -f /tmp/staychat-snapshot.db 2>/dev/null || true
  exit 1
fi

docker cp "staychat:/tmp/staychat-snapshot.db" "$TARGET"
docker exec staychat rm -f /tmp/staychat-snapshot.db

gzip -f "$TARGET"
echo "✓ $(date -Is) backed up → ${TARGET}.gz ($(du -h "${TARGET}.gz" | cut -f1))"

# Prune old snapshots — only after a successful new one exists.
ls -1t "$BACKUP_DIR"/staychat-*.db.gz 2>/dev/null | tail -n +$((BACKUP_KEEP + 1)) | while read -r old; do
  rm -f "$old"
  echo "  pruned $(basename "$old")"
done
