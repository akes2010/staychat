# 09 — Troubleshooting

The only things that actually go wrong, with exact fixes. Ordered by
frequency — check from the top.

---

## 1. HTTPS fails: browser shows cert error / hangs

**Cause chain:** certificate issuance needs Let's Encrypt to reach your server
*and* resolve your domain correctly.

```bash
# ON THE VPS:
dig +short staychatos.com A          # must return THIS server's IP
docker logs caddy --tail 30          # look for ACME/obtain errors
```

| Symptom | Fix |
|---|---|
| `dig` empty/wrong | Cloudflare DNS record missing/typo, or propagation still running → fix the A record ([03-dns-cloudflare.md](03-dns-cloudflare.md)), wait, retry |
| ACME errors in caddy logs, proxy was ON | Cloudflare proxy interfered with issuance → set the record to **DNS only (grey)**, `docker restart caddy`, wait ~1 min |
| Cert fine but browser complains | Cloudflare SSL mode is "Flexible" → set **Full (strict)** ([03-dns-cloudflare.md §4](03-dns-cloudflare.md)) |

Caddy renews certificates automatically ~30 days before expiry — no action
needed ever.

---

## 2. Site unreachable (timeout / connection refused)

Three firewalls can block — check all three:

```bash
ufw status                          # 1) OS firewall: 22/80/443 allowed?
docker ps                           # 2) containers up?
docker logs staychat --tail 50      # 3) app crashed? (see §5)
```

Plus your provider's **cloud firewall panel** (DO/Hetzner/Vultr/GCP/Truehost
each have one) — allow 80/443 there too. Cloudflare proxy ON but origin
blocked shows error **522** to visitors.

---

## 3. Emails never arrive

Expected until configured ([05-configuration.md §1](05-configuration.md)) —
the app logs them and never errors.

After configuring Resend:

- Welcome email test: sign up a throwaway hotel with your own address
- Not arriving? → Resend dashboard shows per-message status; usually the
  domain isn't **Verified** yet (TXT records missing in Cloudflare, or SPF
  merge conflict — see [03-dns-cloudflare.md §5](03-dns-cloudflare.md))
- SMTP route: many providers (Contabo, Truehost) block **port 25** — use
  ports 587/465 or switch to Resend (port 443, never blocked)

---

## 4. An update failed

**Nothing is lost** — `update.sh` rolled back automatically (image + code +
DB) and left maintenance mode ON so users see a clean 503, not a broken app.

```bash
cd /opt/staychat-os
docker logs staychat --tail 100            # why it failed
ls -1t /opt/backups | head -3              # the snapshot it restored from
ls /opt/backups/update-state/*/            # recorded image-id + git-ref
# after fixing the cause (usually: push a fix, then):
bash deploy/update.sh --pull               # retry the whole chain
bash deploy/update.sh --lift-maintenance   # only if you want it up WITHOUT retrying
```

---

## 5. App crash-looping (`docker ps` shows Restarting)

```bash
docker logs staychat --tail 50
```

| Log says | Cause → fix |
|---|---|
| missing env var (`COOKIE_SECRET` etc.) | `.env` typo after an edit → `nano .env`, fix, `docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d` |
| `SQLITE_CORRUPT` / integrity failure | restore latest backup ([08-operations.md §4](08-operations.md)) |
| `EADDRINUSE` | something else took port 3000 (only possible on a shared host) → `ss -tlnp \| grep 3000` |
| migrate/seed error | a bad code state → `git checkout <last-good-tag> && docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build` |

---

## 6. Live updates (WebSocket) not connecting

- Cloudflare proxy: WebSockets work out of the box on all plans — no config
- Check `wss://staychatos.com/ws` in browser devtools → Network → WS tab
- Repeated 401s → the client's session is dead; a hard refresh + re-login
  fixes it (the app auto-refreshes tokens, this is a last-resort state)
- Many staff behind one office IP + `RATE_LIMIT_GLOBAL_MAX` too low → raise
  it in `.env` ([05-configuration.md §4](05-configuration.md))

---

## 7. Login rate-limited (429) during morning rush

The limiter is per-IP. If 30 staff share one office IP and all log in at
08:00, raise `RATE_LIMIT_GLOBAL_MAX` in `.env` (default 200/min → try 400)
and recreate the container. bcrypt logins run in worker threads — the login
burst test (300 simultaneous) passes at single-digit ms API latency.

---

## 8. "Everything is slow"

```bash
docker exec staychat node -e "console.log(process.memoryUsage().rss/1e6|0, 'MB RSS')"
top -bn1 | head -5                  # CPU of the app container
df -h /                             # disk full? (backups/logs)
```

- Disk below ~1 GB free: prune images (`docker image prune -f`), check
  `/opt/backups` retention
- CPU pinned on one core at high load → normal for this architecture until
  the documented 500–1000-user tier; see OPERATIONS.md sizing + the
  SQLite → PostgreSQL scaling path in the README
- Swap thrashing on a tiny plan → add RAM or create the 2 GB swap
  ([02-vps-setup.md §3](02-vps-setup.md))

---

## Nuclear option (last resort, in order)

1. `bash deploy/check-deployment.sh` — what exactly is broken?
2. Restore latest DB backup ([08-operations.md §4](08-operations.md))
3. `git checkout <last-good-tag>` + `docker compose ... up -d --build`
4. Fresh reinstall **never loses data**: re-run `deploy/deploy.sh` (Path A)
   or `setup-vps.sh` (Path B) — both refuse to overwrite an existing `.env`,
   and the DB lives in the `staychat_data` Docker volume, untouched by
   reinstalling. The one thing that erases data is `wipe-demo.sh`, and it
   demands you type `WIPE`.
