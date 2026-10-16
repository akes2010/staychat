# 03 — DNS on Cloudflare (`staychatos.com`)

Point your domain at the VPS and get the proxy/SSL strategy right the first
time. (~10 minutes + DNS propagation wait.)

**Why this order:** the HTTPS certificate is issued automatically on first
contact — Let's Encrypt *must* be able to reach your server directly to do
that. One wrong toggle (Cloudflare's proxy) is the #1 cause of failed first
installs, so this guide pins it correctly.

---

## 1. Add the A record

Cloudflare Dashboard → **staychatos.com** → **DNS** → **Records** → **Add record**:

| Field | Value |
|---|---|
| Type | **A** |
| Name | **@** (that's the apex = `staychatos.com` itself) |
| IPv4 address | `YOUR_VPS_IP` |
| Proxy status | **DNS only** (grey cloud) ← important, see §2 |
| TTL | Auto |

> Want a subdomain instead (`app.staychatos.com`)? Use Name = `app`. This
> guide uses the apex `staychatos.com` throughout — substitute yours.

## 2. Leave the proxy OFF for now (grey cloud)

| Mode | What happens |
|---|---|
| **DNS only (grey)** ✅ during install | Traffic goes straight to your VPS. Caddy can complete the Let's Encrypt check and issue the certificate. |
| Proxied (orange) | Cloudflare sits in front. Usually fine, but on a **first install** it can hide DNS errors and occasionally interfere with certificate issuance — troubleshoot blind. |

**Rule: get everything green with grey cloud first. Enable the proxy
afterwards** (§4) — it's a one-click switch, nothing else changes.

## 3. Verify propagation (from your laptop)

```bash
dig +short staychatos.com A        # must print YOUR_VPS_IP
```

If empty or wrong: wait a few minutes (up to a few hours at some registrars),
then re-check. **Do not proceed until this prints your VPS IP** — the
installer will succeed but HTTPS won't until DNS is right.

---

## 4. After the install is green: turn the proxy ON (recommended)

Once `https://staychatos.com` loads in your browser (end of
[04-install.md](04-install.md)):

1. Cloudflare → DNS → toggle **Proxy status → Proxied (orange)**.
2. Cloudflare → **SSL/TLS** → Overview → set mode to **Full (strict)**.
   - *Never* "Flexible" — it talks plain HTTP to your server, which Caddy
     redirects back to HTTPS → an infinite loop for your users.
   - "Full (strict)" validates the real Let's Encrypt cert Caddy holds.
3. Cloudflare → SSL/TLS → Edge Certificates → enable **Always Use HTTPS**.

What the proxy gives you: hides the server IP, DDoS protection, free CDN
caching of static assets, and built-in WebSocket support (StayChat's live
updates work through Cloudflare without any extra config).

> If anything misbehaves after enabling the proxy, toggle it back to grey —
> your server keeps working either way. The system never depends on the proxy.

---

## 5. Email DNS records (when you set up Resend in step 05)

If you use **Resend** for email (recommended), its wizard shows you records
to add — same Cloudflare DNS page, three new records, all **DNS only**:

| Type | Name | Value (example) | Purpose |
|---|---|---|---|
| TXT | `resend._domainkey` | `v=DKIM1; k=rsa; p=MIIBIjANBg…` | DKIM signing |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:…` | DMARC policy |
| TXT | `@` | `v=spf1 include:amazonses.com ~all` | SPF (merge with any existing SPF!) |

Two SPF TXT records on one domain break SPF — if `@` already has one, merge
them (`v=spf1 include:existing include:amazonses.com ~all`).

SMTP route (own mail server instead of Resend): no DNS records needed here —
but your provider's IP reputation applies.

---

## 6. Optional records you may want later

| Type | Name | Value | For |
|---|---|---|---|
| CNAME | `www` | `staychatos.com` | `www.staychatos.com` visitors (set Cloudflare "CNAME flattening" on, it's default) |
| A | `status` | `YOUR_VPS_IP` | a status page / uptime monitor on a subdomain |

---

## Checkpoint ✓

- [ ] `dig +short staychatos.com A` → your VPS IP
- [ ] Proxy is **grey** (for now)
- [ ] (Later) proxy orange + SSL mode **Full (strict)** after install is green
- [ ] (When doing email) Resend TXT records added, SPF merged

---

## Next → [04-install.md](04-install.md)
