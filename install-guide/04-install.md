# 04 — Install StayChat OS

The actual installation. Two paths — pick **A** (simplest) or **B** (best for
long-term remote maintenance; what this guide recommends).

---

## 0. Pre-flight from your laptop (2 minutes)

Clone/enter the repo and prove it deploys before touching the server:

```bash
cd ~/Downloads/staychat-os          # wherever you cloned this repo
npm run smoke
```

Exit 0 = the repo deploys exactly as a fresh VPS would receive it (real
secrets, migrations from zero, seed, production boot, live signup walkthrough).
Non-zero? Fix that first — it's cheaper than debugging on a VPS.

Make sure DNS from step 03 resolves first:

```bash
dig +short staychatos.com A         # → YOUR_VPS_IP
```

---

## Path A — One command from your laptop

```bash
REMOTE=root@YOUR_VPS_IP DOMAIN=staychatos.com deploy/deploy.sh
```

That single command:
1. uploads the code (never `data/` or `.env` — they don't exist yet anyway)
2. installs Docker + Compose plugin on the VPS
3. generates **fresh secrets** (JWT access/refresh, cookie, credential-encryption key) into `/opt/staychat-os/.env` (chmod 600)
4. opens the firewall (22/80/443 via ufw)
5. builds both containers (`staychat` app + `caddy` HTTPS proxy)
6. seeds demo data (superadmin + demo hotel + starter rooms)
7. waits until `/api/health` is green, then prints your URL

First run takes ~3–8 minutes (mostly the Docker build). Re-running the same
command later safely redeploys (it backs up the DB first).

---

## Path B — Git-based install (recommended)

Future upgrades become a one-line `git push`; the database and `.env` live
outside the code tree forever. ~15 minutes total.

### B1. Deploy key (VPS → GitHub, read-only)

**On the VPS:**

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/staychat_deploy
cat /root/.ssh/staychat_deploy.pub        # copy the whole line
cat >> /root/.ssh/config <<'CFG'
Host github-staychat
  HostName github.com
  User git
  IdentityFile /root/.ssh/staychat_deploy
CFG
```

**On GitHub** → your repo → **Settings → Deploy keys → Add deploy key** →
paste the `.pub` line → leave "Allow write access" **unchecked** → Add key.

### B2. Clone + setup (VPS)

```bash
git clone git@github-staychat:YOUR_USER/YOUR_REPO.git /opt/staychat-os
cd /opt/staychat-os
DOMAIN=staychatos.com bash deploy/setup-vps.sh
```

`setup-vps.sh` does the server-side half: installs Docker (if missing),
writes `/opt/staychat-os/.env` with strong random secrets (**only once** —
re-runs never overwrite), opens ufw 80/443, brings the stack up and installs
the **daily 03:17 DB backup cron** (14 days kept in `/opt/backups`).

---

## Watch the certificate being issued (~1 minute)

Open `docker logs -f caddy` on the server — you'll see Let's Encrypt obtain the
certificate for `staychatos.com`, then:

```
{"level":"info","msg":"serving on https://staychatos.com:443"}
```

Now visit **https://staychatos.com** in your browser — the login screen.

> First HTTPS visit can hang ~30–60s while the cert is issued. If the browser
> errors, wait a minute and retry. Persistent failure →
> [09-troubleshooting.md](09-troubleshooting.md).

---

## First login

| Role | Email | Password |
|---|---|---|
| Super Admin (platform) | `superadmin@staychat.io` | `Demo@123456` |
| Hotel Admin (demo hotel) | `admin@hospitally.com` | `Demo@123456` |

**Immediately change both** (Users page → pick user → reset password), or wipe
demo data entirely in step 06.

---

## Verify from the server

```bash
cd /opt/staychat-os
docker ps                                  # staychat + caddy, both Up/healthy
bash deploy/check-deployment.sh            # full verification suite
curl -s https://staychatos.com/api/health  # healthy JSON, over real HTTPS
```

---

## Checkpoint ✓

- [ ] `docker ps` shows `staychat` and `caddy`, both healthy
- [ ] `https://staychatos.com` loads the login screen with a valid padlock
- [ ] `superadmin@staychat.io` logs in and sees the Super Admin console
- [ ] Both demo passwords changed (or you've scheduled the step-06 wipe)
- [ ] `deploy/check-deployment.sh` passes

---

## Next → [05-configuration.md](05-configuration.md)
