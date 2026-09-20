#!/usr/bin/env bash
# deploy/deploy.sh — deploy StayChat OS to any fresh VPS from your laptop,
# in one command. Works with Contabo, DigitalOcean, GCP, Hetzner, Hostinger
# KVM — any host where you can ssh in as root and ports 80/443 are reachable.
#
# Usage (from the repo root on your machine):
#
#   REMOTE=root@203.0.113.10 DOMAIN=app.example.com deploy/deploy.sh
#
#   REMOTE    ssh target (user@host). Required.
#   DOMAIN    public domain, A-recorded to the VPS IP.
#             Default: staychat.akmustech.com
#   SSH_PORT  ssh port (default 22)
#   APP_DIR   repo location on the server (default /opt/staychat-os)
#
# What it does:
#   First run  → uploads the repo, installs Docker, generates secrets,
#                opens the firewall, builds, starts, installs daily backups.
#   Later runs → backs up the DB, uploads new code, rebuilds, restarts.
#
# No rsync needed (uses tar over ssh), no git remote needed.
set -euo pipefail

: "${REMOTE:?set REMOTE=root@YOUR_VPS_IP}"
DOMAIN="${DOMAIN:-staychat.akmustech.com}"
SSH_PORT="${SSH_PORT:-22}"
APP_DIR="${APP_DIR:-/opt/staychat-os}"
SSH_OPTS=(-p "$SSH_PORT" -o ConnectTimeout=10)

cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "── StayChat OS deploy → $REMOTE ($DOMAIN) ────────────────"

# 0. Preflight
command -v ssh >/dev/null || { echo "✗ ssh not found"; exit 1; }
command -v tar >/dev/null || { echo "✗ tar not found"; exit 1; }
if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$REMOTE" true 2>/dev/null; then
  echo "✓ ssh key auth works"
else
  echo "⚠ ssh key auth failed — you will be prompted for a password (or add your key: ssh-copy-id -p $SSH_PORT $REMOTE)"
fi
command -v node >/dev/null && node --check server/index.js && echo "✓ local syntax check passed"

# 1. Upload the repo (never the server's data, secrets, or junk)
echo "→ Uploading code to $REMOTE:$APP_DIR …"
ssh "${SSH_OPTS[@]}" "$REMOTE" "mkdir -p '$APP_DIR'"
tar czf - \
  --exclude='./.git' \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./.env' \
  --exclude='./deploy/browser-shots' \
  --exclude='./.agents' \
  . | ssh "${SSH_OPTS[@]}" "$REMOTE" "tar xzf - -C '$APP_DIR'"
echo "✓ code uploaded (server-side data/ and .env are never touched)"

# 2. First run → full setup; later runs → backup, rebuild, restart
if ssh "${SSH_OPTS[@]}" "$REMOTE" "test -f '$APP_DIR/.env'"; then
  echo "→ Existing deployment: backing up DB, then rebuilding …"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$APP_DIR' && deploy/backup-db.sh || true"
  ssh "${SSH_OPTS[@]}" "$REMOTE" "cd '$APP_DIR' && \
    docker compose --env-file .env -f deploy/docker-compose.prod.yml build && \
    docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d && \
    docker image prune -f"
else
  echo "→ First deployment on this host: running setup (Docker, secrets, firewall, backups) …"
  ssh -t "${SSH_OPTS[@]}" "$REMOTE" "cd '$APP_DIR' && DOMAIN='$DOMAIN' bash deploy/setup-vps.sh"
fi

# 3. Health check
echo "→ Waiting for the app to be healthy on the server …"
for i in $(seq 1 30); do
  if ssh "${SSH_OPTS[@]}" "$REMOTE" "curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1 || docker exec staychat wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1"; then
    echo "✓ app is healthy"
    echo
    echo "──────────────────────────────────────────────────────────────"
    echo "✓ Deployed.  https://$DOMAIN"
    if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$REMOTE" "getent hosts '$DOMAIN' | grep -q \"\$(curl -s -4 ifconfig.me)\"" 2>/dev/null; then
      echo "  DNS looks correct — Caddy will issue the TLS certificate on first visit (~1 min)."
    else
      echo "  ⚠ DNS check skipped/failed — make sure the A record for $DOMAIN points at this VPS IP,"
      echo "    then visit https://$DOMAIN (cert is issued automatically on first visit)."
    fi
    echo "  Verify:  DOMAIN=$DOMAIN bash deploy/check-deployment.sh   # run on the VPS"
    echo "──────────────────────────────────────────────────────────────"
    exit 0
  fi
  sleep 3
done
echo "✗ app did not become healthy — check: ssh -p $SSH_PORT $REMOTE 'docker logs staychat --tail 50'"
exit 1
