#!/usr/bin/env bash
# deploy/check-deployment.sh — post-deployment health report for staychat.akmustech.com.
# Run on the VPS any time (safe, read-only):  bash deploy/check-deployment.sh
# Exit code 0 = everything critical passed.
set -uo pipefail

DOMAIN="${DOMAIN:-staychat.akmustech.com}"   # override for testing: DOMAIN=localhost SCHEME=http bash deploy/check-deployment.sh
SCHEME="${SCHEME:-https}"                     # on the VPS always https (Caddy terminates TLS)
BASE="$SCHEME://$DOMAIN"
PASS=0; FAIL=0; WARN=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN+1)); }
section() { echo; echo "── $1 ─────────────────────────────"; }

echo "════════════════════════════════════════════════"
echo " StayChat OS — post-deployment check"
echo "════════════════════════════════════════════════"

section "DNS"
DNSIP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
if [ -n "$DNSIP" ]; then ok "$DOMAIN resolves to $DNSIP"; else bad "$DOMAIN does not resolve — fix the A record in the Contabo panel"; fi
PUBIP=$(curl -s -4 --max-time 5 https://ifconfig.me || true)
if [ -n "$PUBIP" ] && [ -n "$DNSIP" ] && [ "$PUBIP" != "$DNSIP" ]; then
  warn "this server's public IP looks like $PUBIP but DNS says $DNSIP"
fi

section "Containers"
docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -E '^(staychat|caddy)' | while IFS=$'\t' read -r name status; do
  echo "  • $name: $status"
done
docker inspect -f '{{.State.Health.Status}}' staychat >/dev/null 2>&1 \
  && { H=$(docker inspect -f '{{.State.Health.Status}}' staychat); [ "$H" = "healthy" ] && ok "staychat healthcheck: $H" || warn "staychat healthcheck: $H"; } \
  || bad "staychat container not found"

section "HTTPS / TLS"
if [ "$SCHEME" = "https" ]; then
  if curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$BASE/api/health" | grep -q 200; then
    ok "$BASE/api/health → 200"
    EXP=$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    [ -n "$EXP" ] && ok "TLS certificate valid until $EXP"
  else
    bad "HTTPS not serving yet — Caddy may still be issuing the certificate (wait ~1 min) or DNS is wrong"
  fi
  HTTP_CODE=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://$DOMAIN/api/health" || true)
  [ "$HTTP_CODE" = "301" ] || [ "$HTTP_CODE" = "308" ] && ok "HTTP redirects to HTTPS ($HTTP_CODE)" || warn "HTTP returned $HTTP_CODE (expected a redirect)"
else
  warn "SCHEME=http (local test mode) — skipping TLS checks"
fi

section "SaaS surfaces"
for p in "/" "/signup" "/pay" "/book.html" "/manifest.json" "/sw.js" "/icon-192.png" "/maskable-512.png"; do
  CODE=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$BASE$p" || true)
  [ "$CODE" = "200" ] && ok "$p → 200" || { [ "$CODE" = "000" ] && bad "$p → connection refused (app down or wrong port)" || bad "$p → $CODE (expected 200)"; }
done

section "Booking engine (public)"
HOTELS=$(curl -s --max-time 10 "$BASE/api/booking-engine/hotels" || echo "[]")
COUNT=$(echo "$HOTELS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
[ "$COUNT" != "0" ] && [ "$COUNT" != "?" ] && ok "$COUNT hotel(s) accept online bookings" \
  || warn "no hotels with the booking engine enabled yet — enable it in Settings → Booking Engine"

section "Database & backups"
docker exec staychat sh -c 'ls -la /app/data/staychat.db' >/dev/null 2>&1 && ok "SQLite database present" || bad "database file missing"
if crontab -l 2>/dev/null | grep -qF "backup-db.sh"; then
  ok "daily backup cron installed"
  LATEST=$(ls -1t /opt/backups/staychat-*.db.gz 2>/dev/null | head -1 || true)
  [ -n "$LATEST" ] && ok "latest backup: $(basename "$LATEST") ($(du -h "$LATEST" | cut -f1))" || warn "cron installed but no backup files yet (runs at 03:17)"
else
  warn "backup cron not installed — run: (crontab -l; echo '17 3 * * * /opt/staychat-os/deploy/backup-db.sh') | crontab -"
fi

section "Email"
cd "$(dirname "${BASH_SOURCE[0]}")/.." || true
if [ -f .env ]; then
  if grep -qE '^RESEND_API_KEY=.' .env && ! grep -qE '^RESEND_API_KEY=$' .env; then
    ok "Resend API key configured"
  elif grep -qE '^SMTP_HOST=.' .env && ! grep -qE '^SMTP_HOST=$' .env; then
    ok "SMTP configured (${EMAIL_FROM})"
  else
    warn "email not configured — sends are logged but not delivered (see SETUP.md §4)"
  fi
else
  bad ".env not found next to this script — run setup-vps.sh first"
fi

section "Automated payments"
if docker exec staychat node -e "
  const s = require('./server/services/platform-settings');
  process.exit(s.has('stripe_secret_key') || s.has('paystack_secret_key') ? 0 : 1);
" >/dev/null 2>&1; then
  ok "platform gateway key configured — subscriptions auto-approve"
else
  warn "no gateway key yet — plan requests use the manual SC- approval flow (Super Admin → Billing & Approvals)"
fi

section "Security spot-check"
CODE=$(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "$BASE/api/plans" || true)
[ "$CODE" = "401" ] && ok "/api/plans requires auth (401)" || bad "/api/plans returned $CODE (expected 401)"
COOKIE_FLAGS=$(curl -s -i --max-time 10 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"nobody@nowhere.example","password":"wrong"}' | grep -i '^set-cookie' || true)
[ -z "$COOKIE_FLAGS" ] && ok "no cookies issued on failed login" || warn "review cookie flags on login response"

echo
echo "════════════════════════════════════════════════"
echo " Result: $PASS passed · $WARN warnings · $FAIL failed"
echo "════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && echo " ✓ Deployment looks healthy." || echo " ✗ Fix the failed checks above (see deploy/SETUP.md)."
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
