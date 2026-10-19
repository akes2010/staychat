// server/services/help-center.js
// ── StayChat OS Knowledge Base ──────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for all user-facing help content:
//   • /help.html           — the public Help Center (user manual + FAQ)
//   • GET /api/help/*      — structured help API
//   • POST /api/chat       — the landing-page assistant (answers come from here)
//
// Honest-by-construction rule: every claim here must match what the system
// actually does in this codebase. Integration counts are pulled LIVE from the
// service registry so the bot can never claim more integrations than exist.
// Pricing facts mirror server/services/entitlements.js PLAN_CATALOG.
'use strict';

const { SERVICE_DEFINITIONS, getCategories } = require('../config/api-services');

const CATS = getCategories();
const TOTAL_SERVICES = Object.keys(SERVICE_DEFINITIONS).length;
const count = c => Object.values(SERVICE_DEFINITIONS).filter(d => d.category === c).length;

const HELP_VERSION = '4'; // bump when manual/FAQ content changes materially

// ── USER MANUAL ──────────────────────────────────────────────────────────────
// Each section: id, icon, title, category (for grouping), keys (search terms),
// body (plain text, • bullets, no markdown syntax).
const MANUAL = [
  {
    id: 'getting-started', icon: '🚀', category: 'Basics',
    title: 'Getting started',
    keys: ['getting started', 'start', 'signup', 'sign up', 'register', 'onboarding', 'begin', 'new hotel', 'account', 'setup', 'set up'],
    body: `1. Click "Start free trial" and register your hotel — no credit card needed. You land in the dashboard on a 14-day trial with every feature unlocked.
2. Set up your property: Rooms → add room types and rates (this powers availability and pricing everywhere).
3. Staff: Users & Permissions → invite your team (receptionist, staff, cashier, barman) and fine-tune each person's permissions if needed.
4. Go live: Settings → Booking Engine → enable it. Your public booking link appears right there — share it on WhatsApp, Instagram or your website.
5. Optional but recommended: Settings → WhatsApp to connect the official WhatsApp Cloud API so the AI receptionist answers guests and the team gets booking alerts.`,
  },
  {
    id: 'dashboard', icon: '⊞', category: 'Basics',
    title: 'Dashboard & navigation',
    keys: ['dashboard', 'navigation', 'sidebar', 'home screen', 'overview', 'live updates', 'realtime', 'real-time'],
    body: `The dashboard is your morning overview: occupancy, arrivals and departures, room status grid, and quick actions.
• The sidebar groups modules by department; items you lack permission for are hidden automatically.
• Everything updates live over WebSocket — open two windows and drag a room's status; the other updates instantly.
• The plan banner on top shows your trial countdown or current plan (visible to everyone; the Billing page itself is owner/admin only).
• Install the app on any phone, tablet or desktop (PWA) — see "Installable app & offline mode".`,
  },
  {
    id: 'rooms-rates', icon: '🛏', category: 'Rooms & Booking',
    title: 'Rooms, rates & availability',
    keys: ['rooms', 'room types', 'rates', 'pricing', 'price', 'availability', 'rack', 'room management', 'holidays', 'festive', 'floor'],
    body: `Rooms → Room Management is where inventory lives.
• Create room types (Standard, Deluxe, Suite…) with base rates, then add individual rooms with numbers, floors and views.
• Rate overrides: set per-date or festive/holiday pricing; weekend rates; the rate card feeds the booking engine and front desk alike.
• Availability is computed live from bookings — a room blocked by a confirmed booking never appears twice.
• Room status (dirty / clean / occupied / ready) flows from housekeeping and check-ins in real time.`,
  },
  {
    id: 'bookings', icon: '📅', category: 'Rooms & Booking',
    title: 'Bookings & reservations',
    keys: ['bookings', 'reservation', 'reservations', 'check-in', 'checkin', 'checkout', 'folio', 'group booking', 'walk-in', 'front desk'],
    body: `Bookings & Reservations handles the full stay lifecycle.
• Create walk-in or phone bookings from the same availability the public engine uses — single or group.
• Check-in enforces balance rules: guests with unsettled balances can be blocked until deposit is posted.
• Folios: room charges, restaurant/bar POS tickets and payments all land on one folio; checkout summarizes and blocks on outstanding balance.
• Deposits are recorded as real money against the folio — never as fake "paid" bookings.
• Every state change is atomic and audit-logged; references (BK-…) are immutable.`,
  },
  {
    id: 'engine', icon: '🌐', category: 'Rooms & Booking',
    title: 'Booking engine (public page)',
    keys: ['booking engine', 'public', 'direct booking', 'ota', 'commission', 'tender code', 'be-', 'book online', 'website widget', 'guest page'],
    body: `Your own commission-free booking channel at /book.html?hotel=<your-subdomain>.
• Guests pick dates (or a hall/pool slot), see live availability priced from your real rate card, and submit name + phone — pay at the hotel.
• The system issues a short tender code (BE-…) readable over the phone; your desk sees the submission in Bookings → Pending instantly.
• One click confirms and holds the inventory; the guest gets WhatsApp updates and a printable confirmation slip with a QR code.
• Guests can look up their booking anytime at /confirmation.html?hotel=<subdomain> with the tender code, or reference + phone number.
• Pending submissions never squat inventory; a daily cap and rate limiting stop spam.
• Facilities: if you add halls or pools, a Facilities tab appears automatically; hotels with none never show it.`,
  },
  {
    id: 'halls-pools', icon: '🎪', category: 'Rooms & Booking',
    title: 'Halls & pool bookings',
    keys: ['halls', 'hall', 'event', 'events', 'pool', 'swimming', 'banquet', 'wedding', 'conference', 'party size', 'hourly', 'day rate'],
    body: `Sell event spaces and pool time alongside rooms.
• Halls: day rate or hourly rate, capacity, category (banquet, conference…). Pool: price per person per hour.
• The public booking page shows a Facilities tab when you have halls or pools; guests pick a date, time window and party size.
• Double-booking prevention is built in: overlapping time windows on the same facility are rejected live.
• Confirmations work exactly like rooms — tender code, WhatsApp updates, printable slip.`,
  },
  {
    id: 'wifi', icon: '📶', category: 'Operations',
    title: 'Guest Wi-Fi',
    keys: ['wifi', 'wi-fi', 'internet', 'bandwidth', 'speed', 'unifi', 'mikrotik', 'meraki', 'hotspot', 'session'],
    body: `Wi-Fi is provisioned automatically from the booking lifecycle.
• Check-in creates the session; checkout revokes it — no stale credentials.
• Speed tiers by room type (e.g. suites 100 Mbps down) are configurable.
• UniFi and MikroTik get real controller pushes; Meraki, Omada and Ruckus sessions are tracked with setup guidance.
• Guests self-serve at /wifi.html with room number + booking reference — no desk queue.
• The desk can extend sessions for late checkouts or revoke early departures.`,
  },
  {
    id: 'wifi-isp-link', icon: '🌐', category: 'Operations',
    title: 'Internet / ISP link & Wi-Fi management',
    keys: ['isp', 'router', 'internet link', 'wan', 'fiber', 'modem', 'upstream', 'failover', 'bonding', 'bandwidth', 'Manage network', 'connection', 'staychat wifi management', 'link staychat to router', 'provider account'],
    body: `Linking your ISP line or router to StayChat turns Wi-Fi from a desk chore into an automated part of the booking lifecycle.

CONNECTION (one-time setup)
1. Keep the ISP modem in bridge mode or put a supported controller behind it — UniFi, MikroTik, TP-Link Omada, Cisco Meraki, Ruckus and Ruckus-managed hotspots all connect.
2. Give StayChat a route to the controller: either the controller's cloud API (UniFi Site Manager, Meraki dashboard, Omada cloud) or a local LAN address the server can reach.
3. Settings → Integrations → Internet: pick your controller, paste the API key / host + credentials, enable, then Test Connection — an authenticated probe runs against the real controller, not a stub.
4. Maps the venue: controller SSIDs and VLANs are picked up automatically; tag the guest SSID so StayChat only provisions guests there (staff network untouched).

MANAGEMENT (what StayChat then does automatically)
• Check-in provisions the guest's session on the guest SSID with room-tier speed (suites faster than standard) and delivers credentials to their WhatsApp.
• Checkout revokes the session — no stale ex-guests on your network.
• Session list (Guest Wi-Fi page) shows who is on, since when, at what rate; desk can extend for late checkout or revoke early.
• Guests self-serve at /wifi.html with room number + booking reference.

MAINTENANCE (keep the link healthy)
• The nightly health sweep pings each connected controller and the WAN gateway; anything unreachable is flagged in the dashboard banner and Settings → Integrations test log.
• If your ISP drops, sessions keep their state in the local database — no lockout storm when the line returns; provisioning queues and catches up.
• ISP failover (two lines / LTE backup): register the second WAN in the same Internet integration list; tests verify both, and the banner shows which uplink is live.
• Change of ISP or router IP? Update the host in Settings → Integrations and Test Connection again — credentials and room tiers are preserved.`,
  },
  {
    id: 'pos-payments', icon: '🧾', category: 'Operations',
    title: 'POS & payments',
    keys: ['pos', 'point of sale', 'restaurant', 'bar', 'orders', 'room service', 'menu', 'charge to room', 'cash', 'card', 'payments', 'paystack', 'stripe'],
    body: `POS covers the restaurant, bar and in-room dining.
• Tickets can charge to a room folio, a group/master account, or be paid directly (cash, card, transfer). The POS till itself is for cashiers/barmen (and managers) — the front desk settles room bills from the Payments page instead.
• Menu Manager keeps items and prices consistent across the POS and room-service flows.
• Payments records every tender type; online gateways (Paystack/Stripe) verify signed webhooks before marking anything paid.
• Only roles with payments.manage can refund or void — the fraud-aware split keeps day-to-day selling separate from money edits.`,
  },
  {
    id: 'accounting-eod', icon: '📒', category: 'Operations',
    title: 'Accounting & end-of-day',
    keys: ['accounting', 'ledger', 'double entry', 'trial balance', 'eod', 'end of day', 'close', 'audit', 'reports', 'export'],
    body: `Every payment and charge posts to a real double-entry ledger.
• The trial balance always balances by construction — no end-of-month surprises.
• End of Day closes each department (front desk, POS, housekeeping) with a role-separated flow; closings are locked and auditable.
• Analytics & Reports covers occupancy, revenue, booking-engine funnel (submissions → confirmations → revenue) and exports.`,
  },
  {
    id: 'housekeeping', icon: '🧹', category: 'Operations',
    title: 'Housekeeping & maintenance',
    keys: ['housekeeping', 'cleaning', 'maintenance', 'technician', 'task', 'sla', 'room status', 'dirty', 'ready'],
    body: `• Housekeeping: tasks auto-assign on checkout with SLA timers; the room-status flow (dirty → cleaning → ready) feeds availability in real time.
• Maintenance: requests reach the right technician; repeated issues on a room build a history.
• Both modules respect the capability matrix — staff operate, managers configure.`,
  },
  {
    id: 'users-permissions', icon: '🔐', category: 'Administration',
    title: 'Users, roles & permissions',
    keys: ['users', 'roles', 'permissions', 'capability', 'receptionist', 'staff role', 'cashier', 'barman', 'who can', 'fraud', 'audit log', 'manager'],
    body: `Roles: hotel_admin (owner/manager), receptionist, staff, cashier, barman (+ superadmin for the platform operator).
• A capability matrix splits day-to-day use (.use) from sensitive management (.manage): front desk can check guests in, but only managers alter prices, void ledgers or cancel paid bookings.
• Every user's permissions are fully customizable in Users & Permissions — editing the checklist takes over from role defaults for that person.
• Billing & Plan is visible to the hotel owner/admin only; staff never see plan, price or payment history.
• Every sensitive action is audit-logged with who/what/when.`,
  },
  {
    id: 'billing-plans', icon: '💳', category: 'Administration',
    title: 'Billing, plans & the free trial',
    keys: ['billing', 'plan', 'plans', 'pricing', 'price', 'cost', 'how much', 'subscription', 'trial', 'free', 'upgrade', 'downgrade', 'invoice', 'sc-', 'payment reference', 'cancel', 'yearly', 'monthly', 'renew', 'payment methods', 'how do i pay', 'one-time', 'one time', 'own outright'],
    body: `Three plans, every one with a 14-day free trial — no card required:
• Starter — $29/mo ($290/yr): up to 20 rooms; booking engine, AI receptionist, front desk, POS.
• Pro — $79/mo ($790/yr): up to 100 rooms; adds guest Wi-Fi, integrations (locks/IPTV/IoT), accounting + EOD, halls, pools, staff shifts.
• Enterprise — $199/mo ($1990/yr): unlimited rooms & properties, custom integrations, dedicated onboarding.
Yearly billing saves 2 months. Direct bookings through your own engine always pay 0% commission.
Activating after the trial: pick a plan (Billing & Plan — owner/admin only), get a payment reference (SC-…), pay by transfer or the platform's gateway. With a gateway key configured, checkout is automatic; otherwise the platform team approves your reference. During the trial, your requested plan's features are live immediately. Renewal reminders go out 7 days and 1 day before expiry.
How you pay: card through Stripe/Paystack hosted checkout when a gateway is configured, or bank transfer / POS quoting your SC- reference — activation is confirmed by email as soon as payment lands.
Prefer to OWN the software instead of subscribing? The Desk PC Edition is the one-time alternative: $3,000 once (40% off the real $5,000 for the first 100 buyers), no renewals ever — see "Desk PC Edition (one-time, self-hosted)".`,
    followups: ['What does the free trial include?', 'How do I pay for my subscription?', 'Tell me about the Desk PC Edition', 'Who can see the Billing page?'],
  },
  {
    id: 'deskpc-edition', icon: '🖥️', category: 'Administration',
    title: 'Desk PC Edition (one-time, self-hosted)',
    keys: ['desk pc', 'desk edition', 'desk app', 'desktop app edition', 'self hosted edition', 'self-hosted edition', 'selfhost', 'offline version', 'offline install', 'local install', 'locally deployable', 'own the software', 'buy outright', 'one time edition', 'one-time payment', '3000', '5000', '40% off', '40 percent', 'first 100', 'launch offer', 'discount', 'software mailed', 'mailed to me', '20 properties', '20 hotels'],
    body: `The Desk PC Edition is the complete StayChat OS platform installed on YOUR own desk PC or local server — sold outright: one payment, yours forever, no subscription.

THE LAUNCH OFFER
• $3,000 once — that's 40% off the real $5,000 price, reserved for the first 100 buyers only. After buyer #100 the price returns to $5,000.
• 20 properties have already purchased it and are enjoying the dividends of the software today — one impressive, holistic hotel solution running on their own premises.
• Perpetual licence: your licence key never expires, no renewals, no monthly bill.

HOW BUYING WORKS (register → pay → software is emailed to you)
1. Open the landing page (Desk PC Edition card in the Pricing section) and fill the simple registration form — name, email, hotel, phone. No account needed, about 20 seconds.
2. You instantly get a quotable reference (SC-XXXXXXXX) and a confirmation email that quotes it.
3. Pay the $3,000 one-time price — hosted card checkout where a payment gateway is configured, or bank transfer / POS quoting your reference.
4. The moment payment is confirmed, StayChat emails the software to you AUTOMATICALLY: your perpetual licence key (SCHK-…) plus a personal download link for the installer — no waiting on a human, no support ticket.
5. Install and run it on your own machine — minutes, not days.

WHAT YOU GET
• The full platform: rooms & rates, bookings, the public booking engine, POS, double-entry accounting + EOD, reports, users & permissions, halls, pools, housekeeping.
• Offline / local-network operation — day-to-day work keeps running without internet, and guest records never leave your premises.
• WhatsApp, cloud integrations and other online features stay optional whenever you do have a connection.

DESK PC vs CLOUD SUBSCRIPTION
• Cloud (Starter $29/mo, Pro $79/mo, Enterprise $199/mo): hosted by us, 14-day free trial, we run the infrastructure — best when you want zero maintenance.
• Desk PC Edition ($3,000 once): your hardware, your data on site, offline-capable, no renewal ever — best when data locality, internet independence or OWNING the software outright matter to you.`,
    followups: ['How much is the Desk PC Edition?', 'How do I get the software after paying?', 'Does the Desk PC Edition work without internet?', 'Who else is using StayChat?'],
  },
  {
    id: 'whatsapp-ai', icon: '🤖', category: 'Guest experience',
    title: 'WhatsApp & the AI receptionist',
    keys: ['whatsapp', 'ai', 'receptionist', 'bot', 'chat', 'message', 'inbox', 'cloud api', 'meta', 'meta developer console', 'developers.facebook.com', 'app setup', 'webhook', 'callback url', 'verify token', 'webhook verify token', 'app secret', 'phone number id', 'access token', 'system user', 'permanent token', 'test number', 'graph api', 'business verification', 'auto reply', 'guest messages'],
    body: `StayChat plugs into the official WhatsApp Business Cloud API. One-time setup (Settings → WhatsApp + Meta's Developer Console), about 15 minutes:

1. Create the Meta app: developers.facebook.com → My Apps → Create App → type "Business", then add the WhatsApp product.
2. Get your credentials (WhatsApp → API Setup): copy the Phone Number ID and create a permanent Access Token via Business Settings → System Users (add your app, grant whatsapp_business_messaging + whatsapp_business_management). Tokens from API Setup expire in 24 hours — use a System User token.
3. Pick your Verify Token: any string you choose (e.g. staychat-verify-2026). You'll paste the SAME string in both places.
4. Copy the App Secret: App Settings → Basic → App Secret.
5. Paste everything into StayChat: Settings → WhatsApp → Phone Number ID, Access Token, Webhook Verify Token, App Secret, and your WhatsApp number → Save. The setup checklist on that card shows what's saved, and "Test Connection" verifies BOTH sides: it self-checks the webhook (handshake + signature gates, exactly what Meta's "Verify and save" and deliveries will hit) and probes your token against Meta's live API. The exact Webhook URL to use is shown right in that card: https://your-domain/api/webhooks/whatsapp/<your-subdomain>.
6. Configure the webhook in Meta: WhatsApp → Configuration → Edit → Callback URL = the URL above, Verify token = your Verify Token string → "Verify and save" (StayChat answers Meta's handshake automatically).
7. Under Webhook fields, subscribe to "messages" — without this Meta never sends guest messages.
8. Test: WhatsApp your business number from any phone. The message lands in Inbox; with Enable AI Receptionist on, the AI replies instantly.

Notes: the App Secret is what makes incoming webhooks trustworthy — StayChat verifies Meta's X-Hub-Signature-256 on every delivery and REJECTS unsigned posts, so don't skip it. Meta's test number can message up to 5 verified recipients only; to reach any guest, add your real business number and complete business verification. Replies are free within the 24-hour customer-service window; outside it you need approved message templates.

Day to day: guest messages land in a real-time shared inbox your whole team sees; the AI receptionist answers availability, facilities, Wi-Fi, room service — and live booking status by tender code — and escalates cleanly to staff. Staff also get WhatsApp alerts for new online bookings and desk decisions. The AI agent itself is configurable (Settings → AI): provider, model, agent role, your own API key.`,
  },
  {
    id: 'integrations', icon: '🔌', category: 'Administration',
    title: 'Integrations',
    keys: ['integration', 'integrations', 'door lock', 'locks', 'iptv', 'tv', 'vod', 'iot', 'camera', 'hikvision', 'dahua', 'zigbee', 'hue', 'sonos', 'control4', 'knx', 'lutron', 'seam', 'vingcard', 'salto', 'ttlock', 'onity', 'dormakaba', 'remotelock', 'unifi', 'meraki', 'mikrotik', 'omada', 'ruckus', 'api', 'webhook', 'twilio', 'sendgrid', 'mailgun', 'resend', 'ses', 'sms', 'email'],
    body: `StayChat integrates with ${TOTAL_SERVICES} services across ${CATS.length} categories:
🚪 Door locks (${count('door_lock')}): Seam, ASSA ABLOY VingCard, SALTO, TTLock, ZKTeco, Onity, dormakaba, RemoteLock
📺 IPTV/VOD (${count('iptv_vod')}): mwareTV, AlphaOTT, VITEC, Samsung LYNK, LG Pro:Centric, HotelTV/VOD
📶 Internet (${count('internet_management')}): UniFi, Meraki, MikroTik, Omada, Ruckus
🏠 Room automation (${count('room_automation')}): Control4, Crestron, KNX, Lutron, Philips Hue, Sonos
📡 IoT & cameras (${count('iot_platform')}): Zigbee2MQTT, Hikvision ISAPI, Dahua, generic MQTT/HTTP
💳 Payments: Stripe, Paystack, Flutterwave, Square — signed, idempotent webhooks
💬 SMS/email: Twilio, Vonage, Africa's Talking, Termii, SendGrid, Mailgun, Resend, AWS SES
Setup: Settings → API Integrations → paste credentials → hit "Test Connection" (cloud APIs get authenticated probes; on-prem gear gets reachability checks). Credentials are AES-256-GCM encrypted and never shown in full after saving.`,
  },
  {
    id: 'pwa', icon: '📲', category: 'Basics',
    title: 'Installable app & offline mode',
    keys: ['pwa', 'install', 'app', 'phone', 'tablet', 'offline', 'home screen', 'mobile', 'android', 'iphone', 'ipad', 'desktop'],
    body: `StayChat OS is a true PWA — install it and it runs like a native app, no app store.
• "Install app" button on the site, or browser menu → Install / Add to Home Screen.
• iPhone/iPad: Safari → Share → "Add to Home Screen".
• Offline mode: the dashboard opens instantly and your last-seen rooms, bookings and rates stay readable when connectivity drops; stale API data is badged.
• Money-moving actions (payments, check-ins) require connectivity so nothing is silently lost.
• Logging out on a shared tablet wipes that device's local cache.`,
  },
  {
    id: 'security', icon: '🛡️', category: 'Administration',
    title: 'Security & multi-tenancy',
    keys: ['security', 'secure', 'multi tenant', 'multi-tenant', 'isolation', 'isolated', 'encrypt', 'encryption', 'data', 'privacy', 'gdpr', 'password', 'jwt', 'auth'],
    body: `• Strict tenant isolation enforced in one middleware chokepoint — hotels can never read each other's bookings, guests or credentials.
• JWT auth with single-use refresh-token rotation; expired WebSocket handshakes are closed cleanly with code 4001 and auto-refresh.
• Integration credentials encrypted at rest (AES-256-GCM).
• Payment webhooks: HMAC over raw bytes, fail-closed, idempotent.
• Rate limiting on auth and public surfaces; helmet hardening; audit log of sensitive actions.`,
  },
  {
    id: 'guests-help', icon: '🧳', category: 'Guest experience',
    title: 'For guests: codes, confirmations & lookups',
    keys: ['tender code', 'code', 'confirmation', 'find my booking', 'find booking', 'lookup', 'look up', 'reference', 'bk-', 'be-', 'qr', 'print', 'guest booking', 'guest code', 'guest confirmation', 'as a guest', 'i booked'],
    body: `Booking as a guest:
1. Open the hotel's booking link, pick dates (or a facility slot), and submit your name + phone — no card needed.
2. You receive a tender code (BE-…) on WhatsApp and on screen. Save it.
3. Need the slip again? Open /confirmation.html?hotel=<hotel-subdomain> and enter the code — or your reference (BK-…) plus the phone number you booked with. Print it or show the QR at the desk.
4. The AI receptionist on WhatsApp can also read your code and answer status questions.
5. Payment happens at the hotel — the confirmation is not a receipt.`,
  },
  {
    id: 'deployment', icon: '🚀', category: 'Administration',
    title: 'Deployment & hosting',
    keys: ['deploy', 'deployment', 'hosting', 'host', 'docker', 'vps', 'server', 'self host', 'self-host', 'caddy', 'https', 'domain', 'dns', 'backup', 'backups', 'requirements', 'node'],
    body: `Self-hosting works on any root VPS (Contabo, DigitalOcean, GCP, Hetzner, Hostinger KVM…) with Ubuntu + Docker:
• One command from your laptop: REMOTE=root@VPS_IP DOMAIN=your.domain deploy/deploy.sh
• It installs Docker, generates secrets, builds, starts app + Caddy (automatic HTTPS), installs daily DB backups (14-day retention).
• The image runs migrate → seed → check → start and fails fast on a broken deploy.
• SQLite by default — zero database ops.
• Health checks: /api/health and /api/health/detailed; full report via bash deploy/check-deployment.sh.
• Re-running the deploy command safely redeploys new code (it backs up the DB first).`,
  },
];

// ── FAQ ──────────────────────────────────────────────────────────────────────
const FAQ = [
  { q: 'Do guests need to pay online to book?', keys: ['pay online', 'payment online', 'card', 'prepay', 'deposit', 'pay at hotel'], a: 'No. The booking engine is "reserve now, pay at the hotel" — guests leave a name and phone number and receive a tender code. Your desk confirms, payment happens at check-in through the normal folio flow. Deposits and online prepayments can be recorded when they arrive.' },
  { q: 'How does the tender code work?', keys: ['tender code', 'code', 'be-', 'pnr'], a: 'Every online booking gets a short code like BE-7K2M9QX4 (no confusing characters, readable over the phone). The guest presents it at the desk, shows the QR-coded confirmation slip, or just tells it to the AI receptionist on WhatsApp, which reads the live status instantly.' },
  { q: 'How do I connect WhatsApp (Meta Developer Console setup)?', keys: ['whatsapp', 'meta', 'developer console', 'setup', 'webhook', 'verify token', 'app secret', 'phone number id', 'access token', 'connect', 'cloud api'], a: 'In developers.facebook.com create a Business-type app and add the WhatsApp product; copy the Phone Number ID (API Setup) and a permanent System User access token; choose any Webhook Verify Token string and copy the App Secret (Settings → Basic). Paste all four into Settings → WhatsApp and Save — the card shows your exact webhook URL (https://your-domain/api/webhooks/whatsapp/<your-subdomain>). In Meta → WhatsApp → Configuration set that URL + your verify token, then subscribe to the "messages" webhook field. Test by messaging your business number — it lands in Inbox and the AI replies. Full walkthrough: Help Center → "WhatsApp & the AI receptionist".' },
  { q: 'I lost my confirmation — how do I find my booking?', keys: ['lost', 'find my booking', 'find booking', 'their booking', 'my booking', 'confirmation', 'lookup', 'reference', 'phone', 'slip'], a: 'Open /confirmation.html?hotel=<hotel-subdomain> and enter your tender code — or your reference (BK-…) plus the phone number you booked with. Both paths render the same printable slip with a QR code.' },
  { q: 'What does the free trial include?', keys: ['trial', 'free', '14 day', '14-day'], a: 'Every plan starts with a 14-day free trial — full features, no credit card. Your requested plan\'s features are live immediately, and you can switch plans any time.' },
  { q: 'What happens when the trial ends?', keys: ['trial ends', 'expire', 'expires', 'after trial', 'suspended'], a: 'Pick a plan in Billing & Plan (owner/admin only). You\'ll get a payment reference (SC-…) — pay by transfer or the platform gateway. With a gateway configured, hosted checkout activates the subscription automatically; otherwise the platform team approves your reference. Renewal reminders go out 7 days and 1 day before expiry. If a subscription lapses, features lock but Billing stays reachable for self-service reactivation.' },
  { q: 'What is the Desk PC Edition?', keys: ['desk pc', 'desk edition', 'desks edition', 'self hosted edition', 'self-hosted edition', 'offline version', 'own the software', 'buy outright', 'one time edition', 'desk app'], a: 'The Desk PC Edition is the complete StayChat OS platform installed on your own desk PC or local server and licensed to you permanently — one $3,000 payment, no subscription, no renewals, and your guest data stays on your premises. It includes the full platform: rooms & rates, bookings, the public booking engine, POS, double-entry accounting + EOD, reports, users & permissions, halls, pools and housekeeping. Twenty properties have already bought it and run it daily. Register in the Desk PC Edition card on the landing page (Pricing section).', followups: ['How much is the Desk PC Edition?', 'How do I get the software after paying?', 'Does the Desk PC Edition work without internet?', 'Desk PC Edition or subscription — which should I choose?'] },
  { q: 'How much is the Desk PC Edition?', keys: ['how much is the desk', 'desk pc price', 'price of the desk pc', '3000', '5000', '40% off', '40%', 'discount', 'first 100', 'launch offer', 'save'], a: '$3,000 once — a 40% launch discount off the real $5,000 price, for the first 100 buyers only (after that it returns to $5,000, so you save $2,000 today). That is a single one-time payment covering the perpetual licence: no monthly bill, no renewals, ever. By comparison the cloud subscription is Starter $29/mo, Pro $79/mo, Enterprise $199/mo (yearly saves 2 months). 20 properties have already claimed theirs — register in the Desk PC Edition card on the landing page to claim one of the remaining launch slots.', followups: ['How do I get the software after paying?', 'Desk PC Edition or subscription — which should I choose?', 'How do I pay for my subscription?', 'Does the Desk PC Edition work without internet?'] },
  { q: 'How do I get the software after paying?', keys: ['get the software', 'after paying', 'download the software', 'software delivery', 'installation package', 'install package', 'license key', 'licence key', 'mailed', 'emailed', 'delivery', 'sent to me', 'software'], a: 'Automatically, by email. Here is the exact flow: register with the simple form on the landing page → you get a quotable SC- reference and a confirmation email → pay the $3,000 (card checkout, or bank transfer/POS quoting your reference) → the instant payment is confirmed, StayChat emails your registered address with the perpetual licence key (SCHK-…) and a personal, tokenized download link for the installer. No support ticket, no waiting for a human. Order status is visible any time through the reference you got at registration, and the same delivery email can be re-sent if it lands in spam.', followups: ['What is the Desk PC Edition?', 'Does the Desk PC Edition work without internet?', 'How do I introduce StayChat to another hotel?'] },
  { q: 'Does the Desk PC Edition work without internet?', keys: ['without internet', 'no internet', 'offline install', 'works offline', 'local network', 'no connection', 'standalone', 'internet'], a: 'Yes — that is the point of the edition. It runs on your own desk PC or local server, so front desk, bookings, POS, accounting and reports keep working on your LAN when the internet is down, and guest records never leave your premises. Optional online features (WhatsApp messaging, cloud integrations) need a connection and simply resume when it returns. Note this is different from the cloud version: as a PWA it keeps your last-seen data readable offline, but its money-moving actions require connectivity.', followups: ['How much is the Desk PC Edition?', 'How do I get the software after paying?', 'Desk PC Edition or subscription — which should I choose?'] },
  { q: 'Desk PC Edition or subscription — which should I choose?', keys: ['or subscription', 'vs subscription', 'which should i choose', 'buy or subscribe', 'self hosted or cloud', 'choose between', 'difference between', 'which one'], a: 'Both run the same platform — it is a hosting choice. Cloud subscription (Starter $29/mo, Pro $79/mo, Enterprise $199/mo, 14-day free trial) means we host it, back it up and update it: zero maintenance, live from 60 seconds. Desk PC Edition ($3,000 once, 40% off $5,000 for the first 100 buyers) means it runs on your own machine: your data never leaves the building, it works without internet, and you never receive another invoice. Rule of thumb: want zero maintenance → subscribe; want data locality, offline operation and outright ownership → buy the Desk PC Edition. Many hotels start on the free trial and buy the Desk PC Edition once they are sure.', followups: ['How much is the Desk PC Edition?', 'What does the free trial include?', 'How do I pay for my subscription?', 'Who else is using StayChat?'] },
  { q: 'How do I pay for my subscription?', keys: ['pay for my subscription', 'how do i pay', 'payment methods', 'bank transfer', 'pos payment', 'card payment', 'pay by', 'pay online', 'checkout', 'paystack', 'stripe', 'gateway', 'payment reference'], a: 'Two ways, both simple. (1) Hosted checkout: when Stripe or Paystack is configured on the platform, clicking pay opens their secure card page and your plan activates automatically once the gateway confirms — signature-verified, idempotent webhooks, so a repeated callback never double-charges. (2) Bank transfer / POS: pick your plan in Billing & Plan and you get an SC- reference — quote it as the narration on the transfer; the platform team confirms it and activation is confirmed to you by email. The Desk PC Edition ($3,000 one-time) works the same way: card checkout or transfer quoting your SC- reference, then the software is emailed the moment payment lands. Renewal reminders go out 7 days and 1 day before every renewal.', followups: ['What does the free trial include?', 'How do I get the software after paying?', 'Who can see the Billing page?'] },
  { q: 'Who else is using StayChat?', keys: ['who else', 'using staychat', 'customers', 'trust', 'proven', 'reliable', 'how many hotels', 'references', 'track record', 'using it'], a: 'Twenty properties have already purchased the Desk PC Edition outright and are enjoying the dividends of the software daily — front desk, bookings, POS, accounting and reports running as one holistic solution on their own machines, with no subscription eating their margin. On top of that you can verify everything yourself in two minutes: "Try the Live Demo" opens a fully seeded hotel, "Book a Stay" runs the real public booking flow, and every cloud plan starts with a 14-day free trial — no card. The suite is also tested by automated browser and security suites on every commit.', followups: ['How much is the Desk PC Edition?', 'How do I introduce StayChat to another hotel?', 'Is there a demo I can try?'] },
  { q: 'How do I introduce StayChat to another hotel?', keys: ['introduce', 'another hotel', 'refer', 'referral', 'share staychat', 'tell a friend', 'spread the word', 'recommend'], a: 'Best way: send them the landing page — one link shows the product, the live demo and both buying paths. Tailor the hook to the hotel: (1) Cloud subscription — 14-day free trial, no card, every feature unlocked, live in 60 seconds; from $29/mo with 0% commission on direct bookings. (2) Desk PC Edition — own the whole platform outright for $3,000 once (40% off the real $5,000 for the first 100 buyers), fully offline, data on their own premises, never a renewal notice again. The OTA-savings calculator on the landing page usually does the convincing for you — most hotels are shocked by what commission is costing them per year.', followups: ['How much is the Desk PC Edition?', 'What does the free trial include?', 'Is there a commission on bookings?'] },
  { q: 'Can two hotels share one installation?', keys: ['multi tenant', 'multi-tenant', 'two hotels', 'multiple hotels', 'shared', 'portfolio', 'properties'], a: 'Yes — StayChat OS is multi-tenant by design. Tenant isolation is enforced in a single middleware chokepoint, so hotels can never read each other\'s bookings, guests or credentials. A platform operator (superadmin) manages the portfolio, plans and approvals from the Super Admin console.' },
  { q: 'Who can see the Billing & Plan page?', keys: ['billing page', 'who can see billing', 'staff billing', 'billing visible', 'owner', 'admin only'], a: 'Only the hotel owner/admin (and the platform superadmin when managing a specific hotel). Staff roles never see the Billing page, plan prices or payment history — enforced in the UI and on the server. The plan banner stays visible to everyone for transparency, but without a "View plan" button for non-managers. Owners can grant billing to a trusted manager via per-user permissions.' },
  { q: 'Can staff change prices or void payments?', keys: ['staff change price', 'void', 'refund', 'fraud', 'who can', 'who is allowed', 'allowed to'], a: 'By default, no. The capability matrix splits .use from .manage: front desk can operate (check in, sell, book) but only manager-level roles alter prices, void ledger entries or cancel paid bookings. Every sensitive action is audit-logged, and per-user permissions are fully customizable.' },
  { q: 'Can I customize what each staff member can do?', keys: ['customize', 'custom permissions', 'custom role', 'individual permissions', 'per user permissions', 'permissions', 'grant billing', 'custom capabilities'], a: 'Yes. Users & Permissions shows a checklist per user; once you edit it, that checklist becomes their complete capability set (role defaults no longer apply to them). You can grant billing access to a trusted manager, for example.' },
  { q: 'Does the AI receptionist really understand bookings?', keys: ['ai', 'receptionist', 'understand', 'booking status', 'smart'], a: 'Yes — it answers availability, facilities, Wi-Fi and room-service questions, and it can look up live booking status by tender code (e.g. "what\'s the status of BE-ABC234?"). Anything it can\'t handle escalates to your staff in the shared inbox. You choose the AI provider/model and can bring your own key in Settings → AI.' },
  { q: 'Which door locks and network gear are supported?', keys: ['door lock', 'locks', 'network', 'gear', 'unifi', 'mikrotik', 'iptv', 'supported hardware'], a: `${count('door_lock')} lock vendors (Seam, VingCard, SALTO, TTLock, ZKTeco, Onity, dormakaba, RemoteLock), ${count('internet_management')} network controllers (UniFi, Meraki, MikroTik, Omada, Ruckus), ${count('iptv_vod')} IPTV platforms and ${count('iot_platform')} IoT/camera integrations — ${TOTAL_SERVICES} services in all, each with a live connection test.` },
  { q: 'How do guests get Wi-Fi?', keys: ['wifi', 'wi-fi', 'internet access', 'hotspot'], a: 'Automatically: check-in creates the Wi-Fi session (speed tiered by room type), checkout revokes it. Guests can self-serve at /wifi.html with room number + booking reference. UniFi and MikroTik get real controller pushes; Meraki/Omada/Ruckus are tracked with setup guidance.' },
  { q: 'Can I sell event halls and pool time?', keys: ['hall', 'halls', 'pool', 'event', 'wedding', 'conference', 'banquet'], a: 'Yes. Add halls (day or hourly rate) and pools (per person per hour) and a Facilities tab appears on your public booking page automatically. Time-window conflicts are rejected live, and confirmations work exactly like room bookings.' },
  { q: 'Is my data isolated from other hotels?', keys: ['isolated', 'isolation', 'data isolation', 'privacy', 'secure', 'security'], a: 'Yes — strict tenant isolation is enforced in a single middleware chokepoint. Credentials are AES-256-GCM encrypted at rest, auth uses JWT with single-use refresh-token rotation, payment webhooks are HMAC-verified and fail closed, and sensitive actions are audit-logged.' },
  { q: 'Can I install it on my phone?', keys: ['install', 'phone', 'pwa', 'app', 'mobile', 'tablet'], a: 'Yes — it\'s an installable PWA. Use the "Install app" button, your browser\'s Install menu, or on iPhone/iPad: Safari → Share → "Add to Home Screen". It runs full-screen like a native app and keeps your last-seen data readable offline.' },
  { q: 'Does it work when the internet drops?', keys: ['offline', 'internet', 'drops', 'down', 'connectivity'], a: 'Reads do. The dashboard opens instantly offline and your last-seen rooms, bookings and rates stay readable (stale data is badged). Money-moving actions require connectivity so nothing is silently lost — writes are refused with a clear message rather than queued.' },
  { q: 'How do I deploy it myself?', keys: ['deploy', 'self host', 'self-host', 'docker', 'vps', 'hosting', 'install server'], a: 'Any root VPS with Ubuntu + Docker works: REMOTE=root@VPS_IP DOMAIN=your.domain deploy/deploy.sh from your laptop. It installs Docker, generates secrets, starts app + Caddy with automatic HTTPS and daily DB backups. SQLite by default — zero database ops. Full guide: deploy/SETUP.md in the repo.' },
  { q: 'Is there a commission on bookings?', keys: ['commission', 'ota', 'fee', 'percentage'], a: 'Zero. Direct bookings through your own booking engine pay no commission — that\'s the whole point. Your only cost is the flat platform subscription. Use the savings calculator on the landing page to see what you keep vs. OTA commissions.' },
  { q: 'What accounting do I get?', keys: ['accounting', 'ledger', 'books', 'trial balance', 'audit'], a: 'A real double-entry ledger: every payment and charge posts balanced entries, the trial balance always balances, and End-of-Day closings are role-separated, locked and auditable. Reports cover occupancy, revenue and the booking-engine funnel, all exportable.' },
  { q: 'Can guests order room service?', keys: ['room service', 'orders', 'restaurant', 'bar', 'menu'], a: 'Yes — the POS handles restaurant, bar and in-room dining. Tickets charge to a room folio, a group account, or are paid directly. Menu Manager keeps items and prices consistent everywhere.' },
  { q: 'How do staff get notified of new bookings?', keys: ['notify', 'notification', 'alert', 'staff notification'], a: 'The desk gets a WhatsApp alert within seconds of a new online submission — code, guest, dates, total. Confirmations and rejections broadcast to the team. Requires connecting WhatsApp in Settings; without it, everything still lands in the in-app inbox.' },
  { q: 'What browsers/devices are supported?', keys: ['browser', 'browsers', 'device', 'devices', 'support', 'chrome', 'safari', 'firefox'], a: 'Any modern browser (Chrome, Edge, Firefox, Safari) on desktop, tablet or phone. As a PWA it installs to the home screen on Android, iOS/iPadOS, Windows and macOS. WebSocket-powered live updates need a normal (non-proxy-broken) network; everything degrades gracefully otherwise.' },
  { q: 'How do backups work when self-hosting?', keys: ['backup', 'backups', 'restore', 'disaster'], a: 'The deploy kit installs a daily 03:17 cron that snapshots the SQLite database (14-day retention in /opt/backups), plus an optional off-site sync script. Manual backup/restore commands are in deploy/SETUP.md. On managed platforms, back up the data volume the same way.' },
  { q: 'Is there a demo I can try?', keys: ['demo', 'try', 'test drive', 'live demo'], a: 'Yes — "Try the Live Demo" on the landing page opens a seeded hotel with front desk, POS, analytics and the booking engine, all real. "Book a Stay" runs the actual public booking flow end to end. Seeded logins use password Demo@123456.' },
];

// ── Search ───────────────────────────────────────────────────────────────────
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function score(text, keys) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return 0;
  const matched = keys.filter(k => q.includes(k));
  // De-dupe overlaps: 'guest' inside a query that already matched 'guests'
  // must not double-count, or short generic keys outscore the real topic.
  const kept = matched.filter(k => !matched.some(o => o !== k && o.includes(k) && o.length > k.length));
  let s = 0;
  for (const k of kept) s += k.length > 4 ? 2 : 1;
  return s;
}

// Best manual sections for a query, sorted (chat + help API + help page search).
function searchManual(query, limit) {
  const ranked = MANUAL
    .map(m => ({ section: m, score: score(query, m.keys) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3)
    .map(x => x.section);
  return ranked;
}

// Best FAQ answers for a query, sorted.
function searchFaq(query, limit) {
  const nq = norm(query);
  const ranked = FAQ
    .map(f => ({ faq: f, score: score(query, f.keys) + (nq && nq.includes(norm(f.q)) ? 4 : 0) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 3)
    .map(x => x.faq);
  return ranked;
}

// Chat-style search: prefer a strong FAQ hit (a direct answer), else the top
// manual section, else a helpful fallback listing what the bot knows.
function search(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;

  const faqs = searchFaq(q, 1);
  const manuals = searchManual(q, 1);
  const faq = faqs[0];
  const manual = manuals[0];
  const nq = norm(q);
  const faqScore = faq ? score(q, faq.keys) + (nq.includes(norm(faq.q)) ? 4 : 0) : 0;
  const manualScore = manual ? score(q, manual.keys) : 0;

  if (faq && faqScore >= manualScore) {
    let answer = faq.a;
    if (manual && manualScore >= 2 && manual.id !== 'getting-started') {
      answer += '\n\nMore: "' + manual.title + '" — see /help#' + manual.id;
    }
    return { id: faq.q, title: faq.q, answer, followups: faq.followups || null };
  }
  if (manual) return { id: manual.id, title: manual.title, answer: manual.body + '\n\nMore: /help#' + manual.id, followups: manual.followups || null };

  return {
    id: 'fallback',
    title: null,
    answer: `I can help with anything about StayChat OS — try asking about:\n\n• The booking engine, tender codes and guest confirmations\n• WhatsApp & the AI receptionist\n• Rooms & rates, halls, pools, POS, accounting, housekeeping\n• Pricing, the 14-day free trial, plan activation and payment\n• The Desk PC Edition — $3,000 one-time (40% off $5,000, first 100 buyers), self-hosted & offline\n• Buying, delivery by email, licences and renewals\n• Users, roles & permissions (billing is owner/admin only)\n• Integrations — ${TOTAL_SERVICES} services (locks, IPTV, Wi-Fi, IoT, payments)\n• Installing the app (PWA) and offline mode\n• Security, multi-tenancy and self-hosting\n\nOr browse the Help Center at /help.html.`,
  };
}

const SUGGESTIONS = [
  'What is StayChat OS?',
  'How much is the Desk PC Edition?',
  'How do I get the software after paying?',
  'Tell me about the Desk PC Edition',
  'How much does it cost?',
  'How do I pay for my subscription?',
  'Does the Desk PC Edition work without internet?',
  'Who else is using StayChat?',
  'How do I introduce StayChat to another hotel?',
  'How does the booking engine work?',
  'Can I install it on my phone?',
  'What integrations are supported?',
];

module.exports = { MANUAL, FAQ, search, searchManual, searchFaq, SUGGESTIONS, HELP_VERSION };
