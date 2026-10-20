# StayChat OS — Complete Install Guide

**Put StayChat OS live on your own server, on your own domain**
(`staychatos.com` on Cloudflare — swap in your own domain anywhere you see it).

This folder is the full, copy-paste, beginner-proof path: from an empty VPS to
a running HTTPS multi-tenant SaaS with automatic GitHub deploys, daily
backups and rollback safety. Every command references a real script in
[`deploy/`](../deploy/) — nothing here is aspirational.

> Provider-agnostic: works on **Contabo, Truehost, DigitalOcean, Hetzner,
> Vultr, Linode, AWS Lightsail, GCP, Hostinger KVM** — any root VPS with
> Ubuntu 22.04/24.04 and ports 80/443 reachable.

---

## Read in this order

| # | File | What it gives you | Time |
|---|---|---|---|
| 0 | [01-prerequisites.md](01-prerequisites.md) | Accounts, server sizing (measured), provider matrix | 10 min |
| 1 | [02-vps-setup.md](02-vps-setup.md) | VPS created, SSH key access, OS baseline (swap, auto-updates, NTP) | 15 min |
| 2 | [03-dns-cloudflare.md](03-dns-cloudflare.md) | `staychatos.com` → your VPS, proxy + SSL strategy, email DNS records | 10 min |
| 3 | [04-install.md](04-install.md) | **The actual install** — one command, or the git-based path | 15 min |
| 4 | [05-configuration.md](05-configuration.md) | Email, payment gateways, WhatsApp, `.env` knobs | 20 min |
| 5 | [06-go-live-checklist.md](06-go-live-checklist.md) | Verify everything, kill demo data, real first hour | 20 min |
| 6 | [07-auto-deploy.md](07-auto-deploy.md) | `git push` → tested → deployed, with auto-rollback | 10 min |
| 7 | [08-operations.md](08-operations.md) | Day-2: logs, backups, offsite copies, updates, restore | keep |
| 8 | [09-troubleshooting.md](09-troubleshooting.md) | The only things that go wrong + exact fixes | keep |

**Total: about 1.5–2 hours** from zero to a live system.

---

## The 30,000-foot view

```
your laptop                     Cloudflare DNS              your VPS
────────────                    ──────────────              ────────
npm run smoke          staychatos.com ──A──► VPS IP         Ubuntu + Docker
deploy/deploy.sh  ────────────────────────────────────────►  staychat  (app :3000, internal)
                                                             caddy     (HTTPS :80/:443, public)
git push master  ──► GitHub CI ──► deploy/update.sh ───────►  swap → backup → migrate → health
```

Two guarantees are built into every path below — you never configure them:

1. **Code and data never mix.** Deploys replace code only; your database and
   `.env` secrets belong to the server and are never touched by any deploy.
2. **Every update is reversible.** DB snapshot first, migrations rehearsed on
   a *copy* of your data, health checks after swap, automatic rollback on any
   failure — customer data survives even a botched release.

---

## Your domain at a glance (`staychatos.com`)

| What | Where it's used |
|---|---|
| `https://staychatos.com` | main app, staff + superadmin login |
| `https://staychatos.com/signup` | self-service hotel registration (30-day trial) |
| `https://staychatos.com/book.html` | public booking engine (per-hotel links) |
| `https://staychatos.com/api/webhooks/...` | WhatsApp + payment-gateway callbacks |
| `wss://staychatos.com/ws` | live updates (proxied by Caddy automatically) |

One DNS A record makes all of these work — no per-service setup.
