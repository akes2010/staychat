# 07 — Auto-Deploy from GitHub

Wire it once: every push to `master` = **CI-tested → backed up → deployed →
health-verified**, with automatic rollback. No SSH needed for updates ever
again. (~10 minutes.)

---

## 1. Server → GitHub: the deploy key

If you installed via **Path B** in [04-install.md](04-install.md), you
already have this key on the VPS — reuse it. Otherwise create one:

**On the VPS:**

```bash
ssh-keygen -t ed25519 -N '' -f /root/.ssh/staychat_deploy
cat /root/.ssh/staychat_deploy        # copy the WHOLE private key
```

**On GitHub** → repo → Settings → Deploy keys → Add (paste the `.pub` line,
read-only). Then copy the **private** key for the next step.

---

## 2. GitHub Actions secrets

**On GitHub** → your repo → Settings → **Secrets and variables → Actions** →
New repository secret, add all four:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `YOUR_VPS_IP` (or `staychatos.com` once DNS is stable) |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | the **whole private key** from step 1 (pasted as-is) |
| `DEPLOY_PATH` | `/opt/staychat-os` (this is the default — optional) |

---

## 3. (Recommended) Manual approval gate

Repo → **Environments** → New environment `production` → **Required
reviewers** → add yourself.

Now every deploy waits for your click in the Actions tab — nothing reaches
production unattended unless you want it to.

---

## 4. Test it end-to-end

```bash
git commit --allow-empty -m "test: verify auto-deploy pipeline"
git push origin master
```

Watch **Actions**:

1. **CI** — the full regression battery (12 suites incl. headless-Chromium
   browser tests). Red ⇒ nothing deploys. Takes ~2–5 min.
2. **Deploy** — runs `deploy/update.sh --pull` on your VPS:
   - records current code + image (rollback points)
   - maintenance mode (clean 503 with retry — health & webhooks stay up)
   - **DB snapshot** (VACUUM INTO + integrity check → `/opt/backups`)
   - `git pull` → build new image
   - **migration dress-rehearsal against a COPY of your live DB** — a bad
     migration aborts here with the old container still serving
   - swap containers → verify health/schema/login/public pages
   - lift maintenance
   - **any failure ⇒ automatic rollback** (image + code + DB), maintenance
     left on so you can inspect

The whole deploy is ~2–4 minutes. If secrets aren't configured yet, the
workflow prints a notice and skips cleanly — CI stays green either way.

---

## 5. Day-to-day

```bash
git push origin master          # that's the entire update procedure
```

Manual/emergency equivalent (same safety chain, run on the VPS):

```bash
cd /opt/staychat-os && bash deploy/update.sh --pull
```

> Safety invariant, enforced by the pipeline: **code and data live in
> different worlds.** `data/` (your SQLite DB) and `.env` (secrets) are
> git-ignored and excluded from every sync path — a deploy can only ever
> change code.

---

## Checkpoint ✓

- [ ] Test push went CI-green → Deploy-green
- [ ] `ssh root@YOUR_VPS_IP 'cd /opt/staychat-os && git rev-parse HEAD'`
      matches your laptop's `git rev-parse HEAD`
- [ ] (If you added the environment gate) you received the approval request

---

## Next → [08-operations.md](08-operations.md)
