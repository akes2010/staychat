# 06 — Go-Live Checklist

The real first hour on production, then wiping the demo data. (~20 minutes.)

---

## 1. Walk the system like a customer would

Use **two browsers** (or one normal + one private window).

### Public side

- [ ] `https://staychatos.com` — landing page loads, padlock valid
- [ ] `https://staychatos.com/signup` — sign up a **test hotel** (14-day
      full-feature trial, auto-seeded: floor, categories, **8 bookable rooms**)
- [ ] `https://staychatos.com/book.html` — the public booking engine: search
      the test hotel, pick a room, complete a booking end-to-end

### The test hotel's desk (log in as the new hotel admin)

- [ ] Dashboard renders with live data
- [ ] Create a reservation → appears instantly
- [ ] Check the guest in → room turns occupied
- [ ] Take a payment → balance updates
- [ ] Settle the balance → receipt + auto-print dialog
- [ ] Check the guest out
- [ ] Open the same page in a **second browser tab** — changes appear live
      (WebSocket) without refreshing

### Platform side (superadmin)

- [ ] Super Admin console: the test hotel appears in Hotels
- [ ] Billing & Approvals shows plan state for it
- [ ] Both demo passwords were changed (if you kept demo data this long)

---

## 2. Wipe demo data (before real hotels arrive)

One command — keeps the superadmin login, secrets and platform settings,
takes a backup first, and requires typing `WIPE`:

```bash
cd /opt/staychat-os && bash deploy/wipe-demo.sh
```

Output ends with the backup path used. After the wipe:

- [ ] `admin@hospitally.com` no longer logs in (demo hotel gone)
- [ ] `superadmin@staychat.io` still works
- [ ] Your **test hotel from §1 survives only if you signed it up AFTER the
      wipe** — if not, sign it up again (takes 60 seconds, that's the point)

Then sign up real hotels at `https://staychatos.com/signup` — each gets its
own isolated workspace, starter inventory and 14-day trial.

---

## 3. Hardening sweep (10 minutes, once)

- [ ] **Cloudflare proxy on** + SSL mode **Full (strict)** (if you left it
      grey for the install — [03-dns-cloudflare.md §4](03-dns-cloudflare.md))
- [ ] `docker ps` — both containers `Up` and `healthy`
- [ ] `bash deploy/check-deployment.sh` — all green **after** the wipe
- [ ] Backups: `ls -1t /opt/backups | head -3` shows today's snapshot
      (the cron ran at 03:17, or run `bash deploy/backup-db.sh` manually)
- [ ] GitHub auto-deploy wired ([07-auto-deploy.md](07-auto-deploy.md)) —
      do a test `git push` and watch Actions go green
- [ ] Offsite backup copy configured ([08-operations.md](08-operations.md) §3)
- [ ] An uptime monitor watches `https://staychatos.com/api/health`
      (Uptime Kuma, UptimeRobot, Cloudflare Health Checks — free options)

---

## 4. The daily rhythm afterwards

| When | What | How |
|---|---|---|
| Every code change | `git push origin master` | CI tests → auto-deploy with rollback safety |
| Weekly glance | `docker ps`, `/opt/backups` free space | 30 seconds |
| Monthly | test-restore a backup to a scratch dir | §4 of [08-operations.md](08-operations.md) |
| Gateway/expiry | handled by the app's hourly scheduler | nothing to do |

---

## Checkpoint ✓ — you are live

- [ ] Real hotel signed up and using it
- [ ] Demo data gone, superadmin survives
- [ ] Backups verified, auto-deploy tested, uptime monitor watching

---

## Next → [07-auto-deploy.md](07-auto-deploy.md)
