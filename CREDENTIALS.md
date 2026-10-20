# Platform Super Admin — login & recovery

> ⚠️ This repository is **PUBLIC**. No passwords or secrets are ever stored
> here on purpose. Keep your password in a password manager.

## Login

| | |
|---|---|
| URL | `https://staychatos.com/app` (local: `http://localhost:3000/app`) |
| Email | `akmustechconcept@gmail.com` |
| Role | `superadmin` (platform scope — sees all hotels) |
| Password | *not stored in git — see recovery below* |

The superadmin console (👑 Super Admin) opens automatically after sign-in:
hotels/tenants, subscriptions, gateways, and platform billing.

## Setting or recovering the password

The superadmin row is created/reset server-side only — public signup always
creates a `hotel_admin` for a new tenant and can never self-assign `superadmin`.

**Local machine:**

```bash
# read-only check (safe anywhere, writes nothing)
node scripts/reset-superadmin.js --check --email=akmustechconcept@gmail.com

# set a new password (idempotent — safe to run again any time)
node scripts/reset-superadmin.js --email=akmustechconcept@gmail.com --password='<choose-a-strong-password>'
```

**Live server (Docker):**

```bash
docker cp scripts/reset-superadmin.js staychat:/tmp/rs.js
docker exec -it staychat node /tmp/rs.js --email=akmustechconcept@gmail.com
# (no --password → prompts with input hidden)
```

No restart needed — changes take effect immediately. The script also
reactivates a deactivated account and revokes its existing sessions.

## After first login

1. Change the password (Users & Permissions → your account).
2. On a fresh deployment, set real secrets in `.env`:
   `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `COOKIE_SECRET`,
   `CREDENTIALS_ENCRYPTION_KEY` — and keep `.env` out of git (it is gitignored).
