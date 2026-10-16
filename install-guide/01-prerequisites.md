# 01 — Prerequisites

What to have ready before touching a server. (~10 minutes of accounts/ordering.)

---

## 1. Accounts you need

| Account | Needed for | Free? |
|---|---|---|
| **Cloudflare** ✅ (you have it) | DNS for `staychatos.com` | yes |
| **VPS provider** (Contabo / Truehost / any cloud) | the server itself | pay monthly |
| **GitHub** | hosting the code → auto-deploys | yes |
| Optional: **Resend** | transactional email (welcome emails, etc.) | generous free tier |
| Optional: payment gateway (Stripe / Paystack / Flutterwave / OPay) | charging hotels for plans | per-transaction |
| Optional: **Meta for Developers** | WhatsApp Business API, per hotel | per-conversation |

Everything optional stays optional — the system runs fully without them
(email logs instead of sending; manual payment approval as fallback).

---

## 2. Server sizing (measured, not guessed)

Numbers from `scripts/load-test.js` — 1000 concurrent staff, 5 tenants,
production mode, SQLite/WAL, single Node process:

| Tier | Concurrent staff | CPU | RAM | Disk | Example plans |
|---|---|---|---|---|---|
| Demo / staging | 1–50 | 2 vCPU | 2–4 GB | 40 GB | smallest VPS anywhere |
| Small production | up to ~500 | 2–4 vCPU ≥3.0 GHz | 4–8 GB | 40–80 GB NVMe | Contabo VPS 100 tier, Hetzner CX22 |
| **Target** | 500–1000 | **4 vCPU ≥3.2 GHz** | **8 GB** | **80 GB NVMe** | Contabo VPS 200 tier, DO 8 GB, Vultr 8 GB |
| Growth | 1000+ | 8 vCPU | 16 GB | 160 GB NVMe | dedicated/bare metal + PostgreSQL path |

**Why these numbers**

- **Single-core speed is #1.** One Node process measured at 77–85% of a core
  at 1000 users. Faster clock = more headroom; extra cores help only WAL I/O,
  Docker, backups and bcrypt worker threads.
- **RAM:** app peak RSS measured ~250 MB; 4 GB is the floor, 8 GB comfortable.
- **Disk:** must be **local NVMe/SSD — never network storage** (SQLite WAL
  requires a local filesystem). Keep ≥20% free.
- **Bandwidth:** worst case ~21 MB/s at 1000 users; any unmetered/10TB plan.

**Starting small is fine** — a 2 vCPU / 4 GB VPS runs production traffic for
a small hotel group and can be upgraded in place later.

> **Not suitable:** shared/cPanel "PHP hosting". The system needs a
> long-running Node process, WebSocket connections, native modules
> (`better-sqlite3`) and a persistent SQLite file. Any root VPS is the path.

---

## 3. Provider matrix

| Step | Contabo | Truehost | DigitalOcean / Hetzner / Vultr / Linode | AWS Lightsail | GCP |
|---|---|---|---|---|---|
| Order | contabo.com → VPS → Cloud VPS | Client Area → KVM VPS | Create Droplet/Server/Instance | Lightsail instance | Compute Engine VM |
| Image | **Ubuntu 24.04 LTS** | **Ubuntu 24.04 LTS** | Ubuntu 22.04/24.04 LTS | Ubuntu 22.04 | Ubuntu 22.04/24.04 |
| Root login | password by email → add SSH key | password in panel | SSH key chosen at creation | key download | SSH key |
| Firewall | none extra (setup opens 22/80/443) | panel may have one → allow 22/80/443 | Cloud firewall: allow 22/80/443 | Lightsail firewall: 22/80/443 | VPC firewall rules: 22/80/443 |
| DNS | use **Cloudflare** (you already do) | use Cloudflare | use Cloudflare | use Cloudflare | use Cloudflare |

Common to all: **root SSH access**, **Ubuntu**, **ports 80 + 443 reachable
from the internet**. Nothing else is provider-specific — the install scripts
contain zero provider APIs.

---

## 4. Your laptop needs

```bash
git --version      # any recent
ssh -V             # any
node --version     # 18+ (22 recommended) — only used for the pre-flight smoke test
```

You'll run one command from your laptop to install; afterwards everything is
maintained from the server (SSH) or GitHub (auto-deploy). No tooling stays
installed on your laptop beyond git/ssh.

---

## 5. Costs reality check

| Item | Typical cost |
|---|---|
| VPS (2 vCPU / 4 GB start) | ~€5–15/mo (Contabo cheapest, Hetzner/DO mid) |
| Domain (you own `staychatos.com`) | already paid |
| Cloudflare DNS | free |
| HTTPS certificates | **free forever** (Let's Encrypt, auto-renewed by Caddy) |
| GitHub + CI | free |
| Resend email | free tier covers early volume |

**Minimum viable monthly cost: the VPS only.**

---

## Next → [02-vps-setup.md](02-vps-setup.md)
