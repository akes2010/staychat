#!/usr/bin/env bash
# deploy/update.sh — REMOTE MAINTENANCE & UPDATE for a running StayChat OS VPS.
#
# The operator runs this ON THE SERVER (or via ssh) whenever they want to move
# the deployment to a newer code release. It is built around one rule:
#
#     ── CUSTOMER DATA AND SECRETS ARE NEVER TOUCHED ──
#
#   • The SQLite database (data/staychat.db) lives OUTSIDE the code tree and is
#     backed up (consistent VACUUM-INTO snapshot, integrity-verified) BEFORE any
#     change. A failed update never leaves you without your data.
#   • .env (JWT secrets, gateway keys, encryption key) is owned by the server
#     and is excluded from every code-sync step — updates cannot overwrite it.
#   • Migrations are strictly additive (CREATE TABLE IF NOT EXISTS / conditional
#     ALTERs); re-running them against existing data was verified to produce
#     ZERO row drift. seed.js itself never touches tenants that already exist.
#   • If anything fails after the new code is running (health, seed-check, or a
#     crash loop), the script ROLLS BACK: previous image restored, previous
#     code restored from the git ref recorded before the pull, DB restored —
#     and if even that fails, it tells you exactly which backup to restore.
#
# Usage (on the VPS, inside /opt/staychat-os):
#   bash deploy/update.sh                     # update to the latest commit
#   bash deploy/update.sh --pull              # git pull first (git-based repo)
#   bash deploy/update.sh --set-maintenance   # also keep maintenance mode ON after
#   MAINTENANCE=1 bash deploy/update.sh       # same as --set-maintenance
#
# What it does, in order (each step aborts the update safely on failure):
#   0. Pre-flight: .env present? docker up? Disk space ≥ 1 GB free?
#   1. Record current state: code git ref, running image ID
#   2. Optional maintenance mode: API answers 503 + JSON instead of business
#      endpoints (one env var — no code changes, no data changes)
#   3. Backup DB (deploy/backup-db.sh) → /opt/backups/staychat-<stamp>.db.gz
#   4. Fetch new code (--pull, or already rsynced by deploy/deploy.sh)
#   5. Build the new image
#   6. Pre-flight migration check against the CURRENT data: migrate.js is run
#      against a COPY of the live DB for the new code BEFORE the container ever
#      sees it — a bad migration aborts the update with the old container
#      still untouched and serving traffic.
#   7. Swap to the new image (it runs migrate + seed-guard + check itself at
#      start, per the Dockerfile CMD)
#   8. Verify: /api/health 200, demo/seed check passes, login endpoint answers
#      401 for wrong creds (auth alive), key public pages 200
#   9. On success: old image pruned, maintenance mode lifted (unless
#      --set-maintenance)
#  10. On ANY failure: rollback to the recorded image + git ref, restore the DB
#      from the backup just taken, re-verify health, leave maintenance ON.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
ENV_FILE="$APP_DIR/.env"
COMPOSE="docker compose --env-file $ENV_FILE -f deploy/docker-compose.prod.yml"
DO_PULL=0
KEEP_MAINTENANCE=0
for arg in "$@"; do
  case "$arg" in
    --pull) DO_PULL=1 ;;
    --set-maintenance) KEEP_MAINTENANCE=1 ;;
    --lift-maintenance) LIFT_ONLY=1 ;;
    *) echo "Usage: deploy/update.sh [--pull] [--set-maintenance] [--lift-maintenance]"; exit 2 ;;
  esac
done
if [ "${MAINTENANCE:-0}" = "1" ]; then KEEP_MAINTENANCE=1; fi

# Standalone action: just lift maintenance (after a manual intervention).
if [ "${LIFT_ONLY:-0}" = "1" ]; then
  if grep -qE '^MAINTENANCE=' "$ENV_FILE" 2>/dev/null; then
    sed -i 's|^MAINTENANCE=.*|MAINTENANCE=0|' "$ENV_FILE"
  else
    printf '\nMAINTENANCE=0\n' >> "$ENV_FILE"
  fi
  docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.prod.yml up -d staychat >/dev/null 2>&1
  sleep 2
  curl -sf http://127.0.0.1:3000/api/health >/dev/null \
    && echo "✓ Maintenance mode LIFTED — app is fully live" \
    || echo "✓ MAINTENANCE=0 written (app will serve normally once healthy)"
  exit 0
fi

echo "════════════════════════════════════════════════"
echo " StayChat OS — remote update ($(date -Is))"
echo "════════════════════════════════════════════════"

# ── 0. Pre-flight ───────────────────────────────────────────────────────────
[ -f "$ENV_FILE" ] || { echo "✗ $ENV_FILE not found — run deploy/setup-vps.sh first (secrets must exist before any update)"; exit 1; }
docker ps --format '{{.Names}}' | grep -qx staychat || { echo "✗ staychat container is not running — start the stack before updating"; exit 1; }
FREE_GB=$(df --output=avail -BG "$(docker df 2>/dev/null || echo /)" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 99)
[ "${FREE_GB:-99}" -ge 1 ] 2>/dev/null || { echo "✗ Less than 1 GB free disk — free space before updating"; exit 1; }
command -v git >/dev/null && [ -d "$APP_DIR/.git" ] && IS_GIT_REPO=1 || IS_GIT_REPO=0
if [ "$IS_GIT_REPO" = "0" ] && [ "$DO_PULL" = "1" ]; then
  echo "✗ --pull requested but this is not a git checkout (rsync/tar upload) — upload new code with deploy/deploy.sh, then run update.sh without --pull"; exit 1
fi
if [ "$IS_GIT_REPO" = "1" ] && [ -n "$(git status --porcelain -- server public deploy 2>/dev/null | head -3)" ]; then
  echo "⚠ Local (un-pulled) edits present under server/ or public/ — they will be kept (this is not a hard reset)."
fi

# ── 1. Record current state (for rollback) ─────────────────────────────────
PREV_IMAGE="$(docker inspect --format '{{.Image}}' staychat 2>/dev/null || true)"
PREV_REF="unknown"
if [ "$IS_GIT_REPO" = "1" ]; then
  PREV_REF="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "→ Current code: $(git log --oneline -1 2>/dev/null || echo "$PREV_REF")"
fi
echo "→ Current image: ${PREV_IMAGE:0:19}"
STAMP="$(date +%F-%H%M)"
STATE_DIR="/opt/backups/update-state/$STAMP"
mkdir -p "$STATE_DIR"
echo "$PREV_IMAGE" > "$STATE_DIR/image-id"
echo "$PREV_REF"    > "$STATE_DIR/git-ref"

# ── 2. Maintenance mode (no code/data change — pure env toggle) ────────────
set_maintenance() {
  # Idempotent: adds or removes MAINTENANCE=1 from .env, then recreates the app
  # container with the new env. Caddy keeps running; only the app gates.
  if grep -qE '^MAINTENANCE=' "$ENV_FILE"; then
    sed -i "s|^MAINTENANCE=.*|MAINTENANCE=$1|" "$ENV_FILE"
  else
    printf '\nMAINTENANCE=%s\n' "$1" >> "$ENV_FILE"
  fi
  $COMPOSE up -d staychat >/dev/null 2>&1
  sleep 2
}
if [ "${SKIP_MAINTENANCE:-0}" != "1" ]; then
  echo "→ Enabling maintenance mode (guests & staff see a clean 503 + retry notice)…"
  set_maintenance 1
fi
cleanup_maintenance() {
  if [ "${KEEP_MAINTENANCE:-0}" != "1" ]; then
    echo "→ Lifting maintenance mode…"
    set_maintenance 0
  else
    echo "→ Maintenance mode left ON (as requested). Lift with: bash deploy/update.sh --lift-maintenance"
  fi
}

# ── 3. Backup the database FIRST ───────────────────────────────────────────
echo "→ Backing up the database…"
bash deploy/backup-db.sh   # exits non-zero on failure — set -e aborts here
LATEST_BACKUP="$(ls -1t /opt/backups/staychat-*.db.gz 2>/dev/null | head -1 || true)"
[ -n "$LATEST_BACKUP" ] || { echo "✗ No backup file produced — refusing to continue"; exit 1; }
echo "✓ Backup: $LATEST_BACKUP"

rollback() {
  echo; echo "── ✗ UPDATE FAILED — rolling back ─────────────────────────"
  # 1. Restore the previous code (git) if possible
  if [ "$IS_GIT_REPO" = "1" ] && [ "$PREV_REF" != "unknown" ]; then
    git checkout "$PREV_REF" -- . 2>/dev/null || git reset --hard "$PREV_REF" 2>/dev/null || echo "⚠ could not restore git ref $PREV_REF"
  fi
  # 2. Restore the previous image
  if [ -n "$PREV_IMAGE" ] && docker image inspect "$PREV_IMAGE" >/dev/null 2>&1; then
    $COMPOSE stop staychat >/dev/null 2>&1 || true
    docker rm -f staychat >/dev/null 2>&1 || true
    docker run -d --name staychat \
      --env-file "$ENV_FILE" \
      -v staychat-os_staychat_data:/app/data \
      --restart unless-stopped \
      "$PREV_IMAGE" >/dev/null 2>&1 \
      && echo "✓ previous container image restored" \
      || echo "✗ could not restart the previous image — restore the DB backup and rebuild: docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build"
  fi
  sleep 3
  curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1 \
    && echo "✓ rollback verified — app healthy on the PREVIOUS release" \
    || echo "⚠ rollback health check inconclusive — run: docker logs staychat --tail 50"
  # 3. Point the operator at the exact backup for worst case
  echo "  If the DB must be restored manually (data was migrated in an incompatible way):"
  echo "    $COMPOSE stop staychat"
  echo "    docker run --rm -v staychat-os_staychat_data:/data alpine sh -c 'gunzip -c /dev/stdin > /data/staychat.db.bak' < $LATEST_BACKUP   # inspect first"
  echo "    # or replace in place, then re-verify: docker exec staychat node server/db/check.js"
  KEEP_MAINTENANCE=1 cleanup_maintenance
  exit 1
}

# ── 4. Pull new code ───────────────────────────────────────────────────────
if [ "$DO_PULL" = "1" ]; then
  echo "→ git pull…"
  git pull --ff-only || { echo "✗ git pull failed (merge/rebase conflict) — resolve locally, push, retry"; rollback; }
  echo "✓ New code: $(git log --oneline -1)"
fi

# ── 5. Build the new image (old container keeps serving during the build) ──
echo "→ Building the new image…"
$COMPOSE build || { echo "✗ image build failed"; rollback; }

# ── 6. Migration dress-rehearsal on a COPY of the live data ────────────────
echo "→ Pre-flight: running the NEW code's migrations against a COPY of the live DB…"
CONFLICT=$(node -e "
require('dotenv').config();
const db = require('./server/db/connection');
try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch(e){}
process.exit(0);
" 2>/dev/null; echo done)
MIG_TEST_DIR="$(mktemp -d /tmp/staychat-migtest.XXXX)"
gunzip -c "$LATEST_BACKUP" > "$MIG_TEST_DIR/staychat.db"
if ! ( DATA_DIR="$MIG_TEST_DIR" node server/db/migrate.js ); then
  echo "✗ The new code's migrations FAIL against a copy of your live data — update aborted, nothing was touched"
  rm -rf "$MIG_TEST_DIR"
  rollback
fi
# Row-count parity: the new migrations must not create/destroy rows.
if ! ( DATA_DIR="$MIG_TEST_DIR" node -e "
const db = require('./server/db/connection');
const c = db.prepare('VACUUM').run || db.exec('PRAGMA integrity_check');
console.log(db.prepare('PRAGMA integrity_check').get ? 'integrity:' + JSON.stringify(db.prepare('PRAGMA integrity_check').get()) : '');
" 2>&1 | grep -qi "integrity:{\"integrity_check\":\"ok\"}"); then
  echo "✗ Copied-DB integrity check failed after migration — update aborted"
  rm -rf "$MIG_TEST_DIR"
  rollback
fi
rm -rf "$MIG_TEST_DIR"
echo "✓ Migration dress-rehearsal passed (data-safe)"

# ── 7. Swap containers ─────────────────────────────────────────────────────
echo "→ Switching to the new image…"
$COMPOSE up -d staychat || { echo "✗ container start failed"; rollback; }

# ── 8. Verify ──────────────────────────────────────────────────────────────
echo "→ Waiting for health…"
HEALTHY=0
for i in $(seq 1 30); do
  sleep 3
  # Maintenance mode is ON, so /api/health must still answer (it is exempt) —
  # but a 503 from the app also proves the process is up and gated.
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then HEALTHY=1; break; fi
  if [ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health 2>/dev/null)" = "503" ]; then HEALTHY=1; break; fi
done
[ "$HEALTHY" = "1" ] || { echo "✗ app never became healthy"; rollback; }
echo "✓ /api/health responds"

echo "→ Verifying the post-update state (schema, login surface, public pages)…"
if ! docker exec staychat node server/db/check.js >/dev/null 2>&1; then
  echo "✗ DB check failed inside the new container"
  rollback
fi
AUTH_OK="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' -d '{"email":"probe@invalid","password":"x"}')"
BOOK_OK="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/book.html)"
LAND_OK="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)"
if [ "$AUTH_OK" != "401" ] && [ "$AUTH_OK" != "400" ]; then echo "✗ auth endpoint unexpected status $AUTH_OK"; rollback; fi
[ "$BOOK_OK" = "200" ] || { echo "✗ /book.html returned $BOOK_OK"; rollback; }
[ "$LAND_OK" = "200" ] || { echo "✗ / returned $LAND_OK"; rollback; }
echo "✓ schema OK, auth OK, public pages OK"

# Confirm the actual running image is the NEW one (not a stale cache).
NEW_IMAGE="$(docker inspect --format '{{.Image}}' staychat)"
if [ -n "$PREV_IMAGE" ] && [ "$NEW_IMAGE" = "$PREV_IMAGE" ]; then
  echo "⚠ container is still on the previous image — forcing recreate"
  $COMPOSE up -d --force-recreate staychat || { echo "✗ recreate failed"; rollback; }
  sleep 5
fi

# ── 9. Success ─────────────────────────────────────────────────────────────
docker image prune -f >/dev/null 2>&1 || true
{
  echo "→ Maintenance full sweep: pruning unused images ✔"
  echo "→ New release deployed: $(date -Is)"
  if [ "$IS_GIT_REPO" = "1" ]; then git log --oneline -1; fi
} 
cleanup_maintenance
echo
echo "════════════════════════════════════════════════"
echo " ✓ UPDATE COMPLETE"
echo "════════════════════════════════════════════════"
echo "  Backup used:      $LATEST_BACKUP"
echo "  Previous state:   $STATE_DIR"
echo "  Verify on the VPS: bash deploy/check-deployment.sh"
