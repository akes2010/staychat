# Post-Deployment Checklist — staychat.akmustech.com

Automated checks: `bash deploy/check-deployment.sh` on the VPS (safe to re-run
any time, exit 0 = healthy). The manual steps below complement it.

## Immediately after `setup-vps.sh`

- [ ] `https://staychat.akmustech.com` loads the landing page (padlock in the
      address bar — Caddy issues the certificate on first visit, allow ~1 min)
- [ ] `bash deploy/check-deployment.sh` passes with 0 failures
- [ ] Log in as `superadmin@staychat.io` / `Demo@123456` → Super Admin console
      renders (hotels, metrics, Billing & Approvals tabs)
- [ ] Log in as `admin@hospitally.com` / `Demo@123456` → dashboard renders,
      room grid appears, WebSocket status dot is green (open two browser
      windows and drag a room's status — the other window updates live)

## First hour

- [ ] **Change demo passwords**: Users → pick each demo user → reset password.
      (Or wipe demo data entirely before real customers — SETUP.md §7.)
- [ ] **Self-signup test**: open `/signup` in a private window, register a
      throwaway hotel with YOUR real email → you land in the app on a Pro
      trial, and the welcome email arrives (if email is configured)
- [ ] **Booking engine test**: from the throwaway hotel, Settings → Booking
      Engine → enable, add 2 rooms, then open
      `https://staychat.akmustech.com/book.html?hotel=<subdomain>` → Search
      Available Rooms shows the rooms → submit a booking → code `BE-…` shown →
      confirmation page opens → booking appears in Bookings → Pending
- [ ] **Email**: if you haven't yet, add `RESEND_API_KEY` (or SMTP creds) to
      `.env` and `docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d`
      (SETUP.md §4) — then re-do the signup test to receive the email

## First day

- [ ] **Payments**: Super Admin → Billing & Approvals → paste your Stripe or
      Paystack key → Save → register the webhook URL shown there with the
      gateway → make a £/$1 test plan request → pay via hosted checkout →
      subscription activates with `approvedBy auto:…` (no manual click)
- [ ] **Renewal reminder path**: the scheduler runs hourly; to preview the
      in-app banner, Billing & Plan shows the 🔔 renewal card in the final
      week of any active subscription (emails go out at 7 days and 1 day)
- [ ] **WhatsApp (optional)**: Settings → WhatsApp per hotel + Meta webhook
      `https://staychat.akmustech.com/api/webhooks/whatsapp/<subdomain>` —
      the full Meta Developer Console walkthrough (Phone Number ID, System
      User token, verify token, App Secret, "messages" subscription) is in
      Help Center → "WhatsApp & the AI receptionist"
- [ ] **Backups**: confirm `/opt/backups/` has a file after the first 03:17
      run (or run `deploy/backup-db.sh` manually right now) - [ ] **Monitoring**: `docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f`
      shows clean logs; `/api/health/detailed` for load-balancer-style checks

## Ongoing

- Weekly: `bash deploy/check-deployment.sh`; glance at `/opt/backups/`
- Before OS updates: `deploy/backup-db.sh` first - Deploying updates: `DOMAIN=<your-domain> deploy/deploy.sh` from your laptop
   (or on the VPS: `git pull && docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build`)
