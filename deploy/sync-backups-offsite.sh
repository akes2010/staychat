#!/usr/bin/env bash
# deploy/sync-backups-offsite.sh — replicate /opt/backups to off-site storage.
# Complements backup-db.sh (which keeps a LOCAL 14-day window; a server loss
# would take those with it). This pushes every local snapshot to an
# S3-compatible bucket via rclone — AWS S3, Contabo Object Storage, Backblaze
# B2, Cloudflare R2, Hetzner, Minio… anything with an S3 API — then prunes the
# REMOTE copy to the same retention window.
#
# One-time setup (on the VPS):
#   apt-get install -y rclone
#   rclone config            # create a remote named OFFSITE_REMOTE (default: staychat-offsite)
#   rclone mkdir staychat-offsite/staychat-backups
#
# Then it runs like the local backup:
#   ./deploy/sync-backups-offsite.sh
#
# Crontab (installed manually after rclone config; runs 30 min after the
# local backup so fresh snapshots are always included):
#   47 3 * * * /opt/staychat-os/deploy/sync-backups-offsite.sh >> /var/log/staychat-offsite.log 2>&1
#
# Env overrides:
#   OFFSITE_REMOTE=staychat-offsite   rclone remote name
#   OFFSITE_PATH=staychat-backups     bucket path
#   BACKUP_DIR=/opt/backups           local source (same as backup-db.sh)
#   OFFSITE_KEEP=30                   days to keep remotely (≥ local retention)
set -euo pipefail

OFFSITE_REMOTE="${OFFSITE_REMOTE:-staychat-offsite}"
OFFSITE_PATH="${OFFSITE_PATH:-staychat-backups}"
BACKUP_DIR="${BACKUP_DIR:-/opt/backups}"
OFFSITE_KEEP="${OFFSITE_KEEP:-30}"

if ! command -v rclone >/dev/null 2>&1; then
  echo "✗ rclone is not installed — run: apt-get install -y rclone && rclone config"
  exit 1
fi

# Fail fast (and clearly) when the remote isn't configured yet.
if ! rclone listremotes | grep -q "^${OFFSITE_REMOTE}:$"; then
  echo "✗ rclone remote '$OFFSITE_REMOTE' not found — run: rclone config  (see header of this script)"
  exit 1
fi

DEST="${OFFSITE_REMOTE}:${OFFSITE_PATH}"

echo "→ syncing ${BACKUP_DIR}/ → ${DEST}/"
rclone sync "$BACKUP_DIR" "$DEST" \
  --include "staychat-*.db.gz" \
  --checksum \
  --stats-one-line

# Prune the remote to the retention window (checksums above keep sync cheap;
# this delete pass only runs server-side metadata, no re-uploads).
CUTOFF=$(date -d "-${OFFSITE_KEEP} days" +%s 2>/dev/null || date -v-${OFFSITE_KEEP}d +%s)
rclone lsf "$DEST" --include "staychat-*.db.gz" | while read -r name; do
  # File names look like staychat-YYYY-MM-DD-HHMM.db.gz — sortable by date.
  filedate=$(echo "$name" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 || true)
  [ -z "$filedate" ] && continue
  ts=$(date -d "$filedate" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$filedate" +%s 2>/dev/null || echo 0)
  if [ "$ts" -gt 0 ] && [ "$ts" -lt "$CUTOFF" ]; then
    rclone deletefile "${DEST}/${name}"
    echo "  pruned remote $name (older than ${OFFSITE_KEEP} days)"
  fi
done

COUNT=$(rclone lsf "$DEST" --include "staychat-*.db.gz" 2>/dev/null | wc -l)
echo "✓ $(date -Is) off-site sync complete — $COUNT snapshot(s) on ${OFFSITE_REMOTE}:${OFFSITE_PATH}"
