# 08 — Operations (day-2)

The keep-this-open reference: logs, backups, updates, restore, maintenance.

---

## 1. Status & logs

```bash
ssh root@YOUR_VPS_IP && cd /opt/staychat-os

docker ps                                    # staychat + caddy Up/healthy
docker logs -f staychat --tail 50            # app logs (Ctrl-C to stop follow)
docker logs -f caddy                         # HTTPS/cert issuance logs
curl -s localhost:3000/api/health            # liveness JSON
bash deploy/check-deployment.sh              # full verification suite
```

Health endpoints for monitoring:
- `GET /api/health` — liveness (point Uptime Kuma / UptimeRobot at
  `https://staychatos.com/api/health`)
- `GET /api/health/detailed` — RSS + cumulative CPU

---

## 2. Backups (already automatic)

`setup-vps.sh` installed a **daily 03:17 cron** running `deploy/backup-db.sh`:

- consistent snapshot via `VACUUM INTO` **inside** the container (WAL-safe —
  never a torn copy)
- integrity-checked before it's kept
- gzipped into `/opt/backups/staychat-YYYY-MM-DD-HHMM.db.gz`
- 14 days retained, pruned automatically
- log: `/var/log/staychat-backup.log`

```bash
bash deploy/backup-db.sh             # manual run any time
ls -1t /opt/backups | head           # newest snapshot first
```

### Offsite copies (3-2-1 — do this once production holds real data)

`deploy/sync-backups-offsite.sh` pushes every local snapshot to any
S3-compatible store (Cloudflare R2, Backblaze B2, AWS S3, Contabo Object
Storage, Hetzner…):

```bash
apt-get install -y rclone
rclone config        # create a remote named: staychat-offsite
rclone mkdir staychat-offsite/staychat-backups
bash deploy/sync-backups-offsite.sh
# then add it to cron, e.g. daily at 04:17:
(crontab -l; echo '17 4 * * * /opt/staychat-os/deploy/sync-backups-offsite.sh >> /var/log/staychat-offsite.log 2>&1') | crontab -
```

> Keep **one copy off the server** — a provider incident takes local
> snapshots with it.

---

## 3. Updates

**Normal path** — `git push origin master` (CI → auto-deploy, see
[07-auto-deploy.md](07-auto-deploy.md)).

**Manual / emergency** (same safety chain as CI):

```bash
cd /opt/staychat-os
bash deploy/update.sh --pull         # git-based install (Path B)
bash deploy/update.sh                # rsync/tar install (Path A)
```

What `update.sh` guarantees: maintenance mode on → DB snapshot → code pull →
image build → **migrations rehearsed on a COPY of your data** → container
swap → health/schema/auth/page verification → maintenance off.
**Any failure = automatic rollback** of image + code + DB, maintenance left
on so you can look around.

Tag releases so any version is identifiable later:

```bash
git tag v1.0.0 && git push --tags
```

---

## 4. Restore (the scary one, made boring)

```bash
cd /opt/staychat-os
ls -1t /opt/backups | head                     # pick the snapshot
docker compose --env-file .env -f deploy/docker-compose.prod.yml stop staychat
gunzip -c /opt/backups/staychat-YYYY-MM-DD-HHMM.db.gz | \
  docker run --rm -i -v staychat-os_staychat_data:/data alpine sh -c \
  'cat > /data/staychat.db'
docker compose --env-file .env -f deploy/docker-compose.prod.yml start staychat
docker exec staychat node server/db/check.js   # verify schema after restore
```

**Test-restore quarterly** (never test on production):

```bash
gunzip -c /opt/backups/staychat-<latest>.db.gz > /tmp/probe.db
docker run --rm -v /tmp/probe.db:/probe.db:ro -v staychat-os_staychat_data:/data alpine \
  sh -c 'cp /probe.db /data/probe.db && echo snapshot-mountable'
```

---

## 5. Config changes & maintenance mode

```bash
cd /opt/staychat-os
nano .env                                         # any config knob
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d

# maintenance mode (clean 503 + retry for guests/staff; health stays up):
sed -i 's/^MAINTENANCE=.*/MAINTENANCE=1/' .env
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d staychat
# lift it:
bash deploy/update.sh --lift-maintenance
```

---

## 6. Disk & retention hygiene

- Alert below **1 GB free** — `update.sh` refuses to run without it
- Log rotation is set in compose (`max-size 10m, max-file 3` per container)
- Periodic: `docker image prune -f` (NEVER `-v` — that deletes data volumes)
- Backups self-prune at 14 days; offsite prunes to the same window

---

## Checkpoint ✓

- [ ] Uptime monitor live on `/api/health`
- [ ] Offsite backup cron installed
- [ ] Restore procedure read once (so 3 a.m. isn't the first time)

---

## Next → [09-troubleshooting.md](09-troubleshooting.md)
