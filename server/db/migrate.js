// server/db/migrate.js
// Creates the full multi-tenant schema. Safe to run multiple times (IF NOT EXISTS).
const { nanoid } = require('nanoid');
const db = require('./connection');

function migrate() {
  db.exec(`
    -- ══════════════════════════════════════════════════════════
    -- TENANTS (Hotels) — root of multi-tenancy
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subdomain TEXT UNIQUE NOT NULL,
      plan TEXT NOT NULL DEFAULT 'starter' CHECK(plan IN ('starter','pro','enterprise')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','trial','suspended')),
      country TEXT,
      email TEXT,
      phone TEXT,
      currency TEXT DEFAULT '$',
      timezone TEXT DEFAULT 'UTC',
      check_in_time TEXT DEFAULT '14:00',
      check_out_time TEXT DEFAULT '11:00',
      mrr INTEGER DEFAULT 29,
      ai_enabled INTEGER DEFAULT 1,
      ai_tone TEXT DEFAULT 'Professional',
      auto_booking INTEGER DEFAULT 1,
      auto_assign_hk INTEGER DEFAULT 1,
      auto_assign_maint INTEGER DEFAULT 1,
      housekeeping_sla INTEGER DEFAULT 45,
      maintenance_sla INTEGER DEFAULT 60,
      wa_phone TEXT,
      wa_phone_id TEXT,
      wa_token TEXT,
      wa_verify_token TEXT,
      wa_app_secret TEXT,
      wa_connected INTEGER DEFAULT 0,
      paystack_public_key TEXT,
      paystack_secret_key TEXT,
      stripe_public_key TEXT,
      stripe_secret_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ══════════════════════════════════════════════════════════
    -- USERS — auth, scoped to a tenant (null tenant_id = superadmin)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('superadmin','hotel_admin','receptionist','staff')),
      department TEXT,
      avatar TEXT,
      phone TEXT,
      active INTEGER DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- REFRESH TOKENS — for JWT rotation
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

    -- ══════════════════════════════════════════════════════════
    -- PASSWORD RESETS — self-service "forgot password" flow
    -- Only the SHA-256 hash of the token is stored; the raw token lives in
    -- the email link alone. One unused reset per user at a time; consumed
    -- tokens stay as an audit trail (used_at).
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pwresets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_pwresets_hash ON password_resets(token_hash);

    -- ══════════════════════════════════════════════════════════
    -- ROOMS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      type TEXT NOT NULL,
      view TEXT,
      floor INTEGER DEFAULT 1,
      rate REAL NOT NULL DEFAULT 0,
      capacity INTEGER DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','occupied','dirty','cleaning','maintenance')),
      guest_name TEXT,
      guest_id TEXT,
      checkout_label TEXT,
      issue TEXT,
      amenities TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, number)
    );
    CREATE INDEX IF NOT EXISTS idx_rooms_tenant ON rooms(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(tenant_id, status);

    -- ══════════════════════════════════════════════════════════
    -- FLOORS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS floors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, number)
    );
    CREATE INDEX IF NOT EXISTS idx_floors_tenant ON floors(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- ROOM CATEGORIES — tiered pricing (weekday/weekend/holiday/discount)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS room_categories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      weekday_rate REAL NOT NULL DEFAULT 0,
      weekend_rate REAL NOT NULL DEFAULT 0,
      holiday_rate REAL NOT NULL DEFAULT 0,
      discount_pct REAL NOT NULL DEFAULT 0,
      capacity INTEGER NOT NULL DEFAULT 2,
      amenities TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_roomcat_tenant ON room_categories(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- HOLIDAYS — dates that trigger the holiday rate tier
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS holidays (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(tenant_id, date)
    );
    CREATE INDEX IF NOT EXISTS idx_holidays_tenant ON holidays(tenant_id, date);

    -- ══════════════════════════════════════════════════════════
    -- SHIFTS & ATTENDANCE
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      department TEXT DEFAULT 'All',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_tenant ON shifts(tenant_id);

    CREATE TABLE IF NOT EXISTS attendance (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      staff_id TEXT REFERENCES staff(id) ON DELETE CASCADE,
      staff_name TEXT NOT NULL,
      shift_id TEXT REFERENCES shifts(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      clock_in TEXT,
      clock_out TEXT,
      status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','late','absent','on_leave')),
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_tenant_date ON attendance(tenant_id, date);
    CREATE INDEX IF NOT EXISTS idx_attendance_staff ON attendance(staff_id, date);

    -- ══════════════════════════════════════════════════════════
    -- GUESTS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS guests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      room_number TEXT,
      loyalty_tier TEXT DEFAULT 'Bronze' CHECK(loyalty_tier IN ('Bronze','Silver','Gold','Platinum')),
      loyalty_points INTEGER DEFAULT 0,
      stays INTEGER DEFAULT 0,
      total_spent REAL DEFAULT 0,
      preferences TEXT DEFAULT '[]',
      check_in_date TEXT,
      check_out_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_guests_tenant ON guests(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_guests_phone ON guests(tenant_id, phone);

    -- ══════════════════════════════════════════════════════════
    -- BOOKINGS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
      room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
      reference TEXT UNIQUE NOT NULL,
      check_in TEXT NOT NULL,
      check_out TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','confirmed','checked_in','checked_out','cancelled')),
      total_amount REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_ref TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_tenant ON bookings(tenant_id);

    -- Rooms attached to a booking (supports group bookings with multiple rooms)
    CREATE TABLE IF NOT EXISTS booking_rooms (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      room_number TEXT NOT NULL,
      rate REAL NOT NULL DEFAULT 0,
      occupant_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookingrooms_booking ON booking_rooms(booking_id);
    CREATE INDEX IF NOT EXISTS idx_bookingrooms_tenant ON booking_rooms(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- POOL BOOKINGS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS pool_bookings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      guest_name TEXT NOT NULL,
      guest_phone TEXT,
      room_number TEXT,
      guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      party_size INTEGER NOT NULL DEFAULT 1,
      area TEXT DEFAULT 'Main Pool',
      price REAL NOT NULL DEFAULT 0,
      paid INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','checked_in','completed','cancelled','no_show')),
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pool_tenant_date ON pool_bookings(tenant_id, date);

    -- ══════════════════════════════════════════════════════════
    -- HALLS (banquet / event spaces) + BOOKINGS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS halls (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 50,
      hourly_rate REAL NOT NULL DEFAULT 0,
      day_rate REAL NOT NULL DEFAULT 0,
      amenities TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_halls_tenant ON halls(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- POOLS — categorized bookable pool areas (Main Pool, Kids Pool, VIP Cabana…)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS pools (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Standard',
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      capacity INTEGER NOT NULL DEFAULT 20,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pools_tenant ON pools(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- SUBSCRIPTION PLANS (superadmin-managed) + PAYMENT GATEWAYS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price_monthly REAL NOT NULL DEFAULT 0,
      price_yearly REAL NOT NULL DEFAULT 0,
      features TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payment_gateways (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- 'bank_transfer' | 'pos' | 'crypto' | 'paypal' | 'payoneer' | 'airtm' | 'card' | 'other'
      description TEXT,
      config TEXT DEFAULT '{}',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- ══════════════════════════════════════════════════════════
    -- AI PROVIDER CONFIGURATION (per tenant)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS ai_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      provider TEXT NOT NULL, -- 'openai' | 'qwen' | 'deepseek' | 'huggingface' | 'openrouter' | 'kimi' | 'zai' | 'other'
      label TEXT NOT NULL,
      model TEXT,
      api_key TEXT,
      agent_role TEXT DEFAULT 'receptionist', -- which agent this powers: receptionist / concierge / support
      monthly_surcharge REAL NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tenant ON ai_configs(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- EXTERNAL API SERVICE CONFIGURATION (per tenant)
    -- Stores credentials/settings for any service in the api-services
    -- registry (payment gateways, OTA channels, SMS/email, storage…).
    -- The credentials column is a JSON blob of { credentialKey: value }.
    -- One row per (tenant, service_key).
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS tenant_api_configs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_key TEXT NOT NULL,   -- e.g. 'stripe', 'booking_com', 'twilio'
      category TEXT NOT NULL,      -- e.g. 'payment_gateway', 'ota_channel', 'sms_provider'
      label TEXT,                  -- optional friendly label set by the tenant
      credentials TEXT NOT NULL DEFAULT '{}', -- JSON: { credentialKey: value }
      test_mode INTEGER NOT NULL DEFAULT 0,   -- 1 = sandbox/test credentials
      active INTEGER NOT NULL DEFAULT 0,       -- 1 = enabled for use
      last_verified_at TEXT,       -- last successful connection test
      last_error TEXT,             -- last connection-test error message
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, service_key)
    );
    CREATE INDEX IF NOT EXISTS idx_apiconfigs_tenant ON tenant_api_configs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_apiconfigs_category ON tenant_api_configs(tenant_id, category);

    -- ══════════════════════════════════════════════════════════
    -- PRINTERS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('thermal_80','thermal_58','a4')),
      department TEXT NOT NULL DEFAULT 'Front Desk', -- Restaurant / Bar / Front Desk / Back Office
      connection TEXT DEFAULT 'usb', -- 'usb' | 'network' | 'bluetooth'
      address TEXT, -- IP address or device identifier
      is_default INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_printers_tenant ON printers(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- ACCOUNTING — chart of accounts, double-entry journal, vouchers
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','income','expense')),
      normal_balance TEXT NOT NULL CHECK(normal_balance IN ('debit','credit')),
      system_key TEXT, -- stable key used by auto-posting code, e.g. 'cash','pos_revenue','room_revenue','ar_room','ar_customer'
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, code)
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON accounts(tenant_id);

    CREATE TABLE IF NOT EXISTS journal_entries (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      reference TEXT,
      description TEXT,
      source TEXT DEFAULT 'manual', -- 'manual' | 'pos' | 'payment' | 'booking' | 'voucher'
      source_id TEXT,
      posted INTEGER DEFAULT 1,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_journal_tenant_date ON journal_entries(tenant_id, date);

    CREATE TABLE IF NOT EXISTS journal_lines (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      memo TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journallines_entry ON journal_lines(entry_id);
    CREATE INDEX IF NOT EXISTS idx_journallines_account ON journal_lines(account_id);

    CREATE TABLE IF NOT EXISTS vouchers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      voucher_no TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('payment','receipt','journal','contra')),
      date TEXT NOT NULL,
      narration TEXT,
      amount REAL NOT NULL DEFAULT 0,
      entry_id TEXT REFERENCES journal_entries(id) ON DELETE SET NULL,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, voucher_no)
    );
    CREATE INDEX IF NOT EXISTS idx_vouchers_tenant ON vouchers(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- END OF DAY CLOSINGS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS eod_closings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      department TEXT NOT NULL, -- 'front_desk' | 'restaurant' | 'bar' | 'pool' | 'hall' | 'misc_services'
      date TEXT NOT NULL,
      closed_by TEXT,
      closed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      totals TEXT DEFAULT '{}', -- JSON snapshot: { cash, card, room_charge, customer_bill, group_account, count }
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'closed' CHECK(status IN ('closed','reopened')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, department, date)
    );
    CREATE INDEX IF NOT EXISTS idx_eod_tenant_date ON eod_closings(tenant_id, date);

    -- ══════════════════════════════════════════════════════════
    -- MISC SERVICES (shoe shine, laundry, car wash/repair, etc.)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS misc_services (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Other', -- Laundry / Shoe Care / Car Service / Other
      price REAL NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_miscservices_tenant ON misc_services(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- BOOKING ENGINE CONFIG — per-tenant public booking widget
    -- Enabled/disabled, optional booking notice, and daily submission cap.
    -- Engine submissions land in the bookings table with status 'pending_payment' and
    -- engine_sync_status 'pending'; the front desk confirms them by tendering
    -- the engine code, which flips the booking to 'confirmed'.
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS booking_engine_config (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      notice TEXT,
      max_daily INTEGER NOT NULL DEFAULT 50,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ══════════════════════════════════════════════════════════
    -- WIFI PROVISIONS — per-room guest internet sessions
    -- Created on check-in (speed tier by room type), extended on late stays,
    -- revoked on checkout. Credentials never touch the DB unencrypted; the
    -- controller-side identity is what the network gear enforces.
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS wifi_provisions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
      room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
      room_number TEXT,
      guest_name TEXT,
      controller TEXT NOT NULL,           -- service_key: unifi | meraki | mikrotik | omada | ruckus
      identity TEXT NOT NULL,             -- controller-side username/client identity
      password_enc TEXT,                  -- encrypted at rest (AES-256-GCM)
      speed_down_mbps INTEGER,            -- the tier granted on check-in
      speed_up_mbps INTEGER,
      quota_gb REAL,                      -- data cap for the session, if any
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
      auto INTEGER DEFAULT 1,             -- auto-provisioned on check-in vs created manually
      granted_by TEXT,
      revoked_at TEXT,
      revoke_reason TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wifi_tenant_status ON wifi_provisions(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_wifi_tenant_room ON wifi_provisions(tenant_id, room_number);
    CREATE INDEX IF NOT EXISTS idx_wifi_tenant_booking ON wifi_provisions(tenant_id, booking_id);

    CREATE TABLE IF NOT EXISTS misc_service_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      service_id TEXT REFERENCES misc_services(id) ON DELETE SET NULL,
      service_name TEXT NOT NULL,
      guest_name TEXT,
      room_number TEXT,
      qty INTEGER NOT NULL DEFAULT 1,
      price REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      payment_method TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','cancelled')),
      transaction_id TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_miscorders_tenant_date ON misc_service_orders(tenant_id, created_at);

    CREATE TABLE IF NOT EXISTS hall_bookings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      hall_id TEXT NOT NULL REFERENCES halls(id) ON DELETE CASCADE,
      event_name TEXT NOT NULL,
      event_type TEXT DEFAULT 'Meeting',
      organizer_name TEXT NOT NULL,
      organizer_phone TEXT,
      organizer_email TEXT,
      event_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      guest_count INTEGER DEFAULT 1,
      setup_style TEXT DEFAULT 'Theatre',
      catering INTEGER DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      deposit_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'tentative' CHECK(status IN ('tentative','confirmed','completed','cancelled')),
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hallbookings_tenant ON hall_bookings(tenant_id, event_date);
    CREATE INDEX IF NOT EXISTS idx_hallbookings_hall ON hall_bookings(hall_id, event_date);

    -- ══════════════════════════════════════════════════════════
    -- ORDERS (Room Service)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      room_number TEXT NOT NULL,
      guest_name TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','preparing','delivered','cancelled')),
      note TEXT,
      paid INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id, status);

    -- ══════════════════════════════════════════════════════════
    -- MENU ITEMS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Mains',
      price REAL NOT NULL DEFAULT 0,
      description TEXT,
      available INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_menu_tenant ON menu_items(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- POS TICKETS — Restaurant & Bar point-of-sale
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS pos_tickets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      outlet TEXT NOT NULL DEFAULT 'restaurant' CHECK(outlet IN ('restaurant','bar')),
      label TEXT NOT NULL DEFAULT 'Walk-in',
      guest_name TEXT,
      guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
      room_number TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      subtotal REAL NOT NULL DEFAULT 0,
      discount_pct REAL NOT NULL DEFAULT 0,
      service_pct REAL NOT NULL DEFAULT 0,
      tax_pct REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','void')),
      payment_method TEXT CHECK(payment_method IN ('cash','card','room_charge','customer_bill')),
      transaction_id TEXT,
      note TEXT,
      opened_by TEXT,
      closed_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      closed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pos_tenant ON pos_tickets(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_pos_outlet ON pos_tickets(tenant_id, outlet, status);

    -- ══════════════════════════════════════════════════════════
    -- STAFF
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      department TEXT NOT NULL DEFAULT 'Front Desk',
      shift TEXT DEFAULT 'Morning',
      phone TEXT,
      email TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','break','busy','off-duty')),
      tasks_completed INTEGER DEFAULT 0,
      avg_time TEXT DEFAULT '—',
      joined_date TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- MAINTENANCE REQUESTS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS maintenance_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      room_number TEXT NOT NULL,
      issue TEXT NOT NULL,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in-progress','completed')),
      assignee TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_maint_tenant ON maintenance_requests(tenant_id, status);

    -- ══════════════════════════════════════════════════════════
    -- CONVERSATIONS + MESSAGES (WhatsApp inbox)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
      guest_name TEXT NOT NULL,
      guest_phone TEXT,
      room_number TEXT,
      online INTEGER DEFAULT 0,
      unread_count INTEGER DEFAULT 0,
      last_message TEXT,
      last_message_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conv_tenant ON conversations(tenant_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender TEXT NOT NULL CHECK(sender IN ('guest','ai','staff')),
      body TEXT NOT NULL,
      ai_generated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);

    -- ══════════════════════════════════════════════════════════
    -- PAYMENTS / TRANSACTIONS
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      guest_name TEXT,
      room_number TEXT,
      description TEXT,
      amount REAL NOT NULL DEFAULT 0,
      method TEXT DEFAULT 'Paystack',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','refunded')),
      gateway_ref TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn_tenant ON transactions(tenant_id);

    -- ══════════════════════════════════════════════════════════
    -- AUDIT LOG — security & compliance trail
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at);

    -- ══════════════════════════════════════════════════════════
    -- ANALYTICS SNAPSHOTS (daily rollups for charts)
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS analytics_daily (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      revenue REAL DEFAULT 0,
      occupancy_pct REAL DEFAULT 0,
      orders_count INTEGER DEFAULT 0,
      new_bookings INTEGER DEFAULT 0,
      UNIQUE(tenant_id, date)
    );
  `);

  // ── Backward-compatible column additions (SQLite has no "ADD COLUMN IF NOT EXISTS") ──
  const menuCols = db.prepare("PRAGMA table_info(menu_items)").all().map(c => c.name);
  if (!menuCols.includes('outlet')) {
    db.exec("ALTER TABLE menu_items ADD COLUMN outlet TEXT NOT NULL DEFAULT 'both'");
  }
  const tenantCols = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
  if (!tenantCols.includes('pos_tax_pct')) {
    db.exec("ALTER TABLE tenants ADD COLUMN pos_tax_pct REAL NOT NULL DEFAULT 0");
  }
  if (!tenantCols.includes('pos_service_pct')) {
    db.exec("ALTER TABLE tenants ADD COLUMN pos_service_pct REAL NOT NULL DEFAULT 0");
  }
  if (!tenantCols.includes('pool_capacity')) {
    db.exec("ALTER TABLE tenants ADD COLUMN pool_capacity INTEGER NOT NULL DEFAULT 20");
  }
  [
    ['plan_id', 'TEXT'],
    ['billing_cycle', "TEXT NOT NULL DEFAULT 'monthly'"], // 'monthly' | 'yearly'
    ['subscription_status', "TEXT NOT NULL DEFAULT 'active'"], // 'active' | 'suspended' | 'terminated'
    ['next_billing_date', 'TEXT'],
    ['payment_methods', "TEXT NOT NULL DEFAULT '[\"cash\",\"card\"]'"], // hotel-customizable accepted payment modes
    ['payment_method_configs', "TEXT NOT NULL DEFAULT '{}'"], // structured details per method (bank account, PayPal email, etc.)
    ['exchange_rates', "TEXT NOT NULL DEFAULT '{}'"], // USD exchange rates fetched from API: { EUR: 0.92, NGN: 1580, ... }
    ['exchange_rates_updated_at', 'TEXT'], // Last time rates were refreshed
  ].forEach(([col, def]) => { if (!tenantCols.includes(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`); });

  // menu_items → POS product-management fields
  const menuCols2 = db.prepare("PRAGMA table_info(menu_items)").all().map(c => c.name);
  [
    ['cost_price', "REAL NOT NULL DEFAULT 0"],
    ['discount_pct', "REAL NOT NULL DEFAULT 0"],
    ['barcode', "TEXT"],
    ['sku', "TEXT"],
    ['image_url', "TEXT"],
    ['stock_qty', "INTEGER"],
    ['loyalty_points', "REAL NOT NULL DEFAULT 0"],
  ].forEach(([col, def]) => { if (!menuCols2.includes(col)) db.exec(`ALTER TABLE menu_items ADD COLUMN ${col} ${def}`); });

  // bookings → group / reservation fields
  const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  [
    ['guest_name', "TEXT"],
    ['guest_phone', "TEXT"],
    ['guest_email', "TEXT"],
    ['is_group', "INTEGER NOT NULL DEFAULT 0"],
    ['group_name', "TEXT"],
    ['adults', "INTEGER NOT NULL DEFAULT 1"],
    ['children', "INTEGER NOT NULL DEFAULT 0"],
    ['source', "TEXT NOT NULL DEFAULT 'direct'"],
    ['deposit_amount', "REAL NOT NULL DEFAULT 0"],
    ['created_by', "TEXT"],
  ].forEach(([col, def]) => { if (!bookingCols.includes(col)) db.exec(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`); });

  // users → permission overrides + status label + personal theme (skin colour)
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('permissions')) db.exec("ALTER TABLE users ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'");
  if (!userCols.includes('theme')) db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'green'");

  // users.role CHECK constraint → add dedicated POS-terminal-only roles (cashier, barman).
  // SQLite can't alter a CHECK constraint in place, so rebuild the table.
  const usersTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (usersTableSql && !usersTableSql.sql.includes('cashier')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('superadmin','hotel_admin','receptionist','staff','cashier','barman')),
        department TEXT,
        avatar TEXT,
        phone TEXT,
        active INTEGER DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        permissions TEXT NOT NULL DEFAULT '[]'
      );
      INSERT INTO users_new (id, tenant_id, name, email, password_hash, role, department, avatar, phone, active, last_login_at, created_at, permissions)
        SELECT id, tenant_id, name, email, password_hash, role, department, avatar, phone, active, last_login_at, created_at, permissions FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    `);
    db.pragma('foreign_keys = ON');
  }

  // rooms → link to floors/room_categories (legacy floor int / rate / type columns kept for compatibility)
  const roomCols = db.prepare("PRAGMA table_info(rooms)").all().map(c => c.name);
  [['floor_id', 'TEXT'], ['category_id', 'TEXT'], ['description', 'TEXT']].forEach(([col, def]) => { if (!roomCols.includes(col)) db.exec(`ALTER TABLE rooms ADD COLUMN ${col} ${def}`); });

  // room_categories → festive rate tier (4th pricing tier, above holiday)
  const roomCatCols = db.prepare("PRAGMA table_info(room_categories)").all().map(c => c.name);
  if (!roomCatCols.includes('festive_rate')) db.exec("ALTER TABLE room_categories ADD COLUMN festive_rate REAL NOT NULL DEFAULT 0");

  // holidays → distinguish regular holidays from festive (premium) dates
  const holidayCols = db.prepare("PRAGMA table_info(holidays)").all().map(c => c.name);
  if (!holidayCols.includes('type')) db.exec("ALTER TABLE holidays ADD COLUMN type TEXT NOT NULL DEFAULT 'holiday'");

  // halls → description + category label, and pool_bookings → link to a configured pool
  const hallCols = db.prepare("PRAGMA table_info(halls)").all().map(c => c.name);
  [['description', 'TEXT'], ['category', "TEXT NOT NULL DEFAULT 'Standard'"]].forEach(([col, def]) => { if (!hallCols.includes(col)) db.exec(`ALTER TABLE halls ADD COLUMN ${col} ${def}`); });
  const poolBookingCols = db.prepare("PRAGMA table_info(pool_bookings)").all().map(c => c.name);
  if (!poolBookingCols.includes('pool_id')) db.exec("ALTER TABLE pool_bookings ADD COLUMN pool_id TEXT REFERENCES pools(id) ON DELETE SET NULL");

  // eod_closings → attribute each closing to the exact staff account that made
  // it ("each user sees their own EOD; the owner/admin sees and manages all")
  const eodCols = db.prepare("PRAGMA table_info(eod_closings)").all().map(c => c.name);
  if (!eodCols.includes('closed_by_user_id')) db.exec("ALTER TABLE eod_closings ADD COLUMN closed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL");

  // hall_bookings & pool_bookings → booking-engine (public OTA channel) fields.
  // Guests can reserve halls/pool slots from the public booking page exactly like
  // rooms: submission lands as 'tentative'/'confirmed' + engine_sync_status
  // 'pending' with a tender code; the desk confirms/rejects by that code.
  // pool_bookings.status has no 'pending_payment' value in its CHECK constraint,
  // so pool submissions stay 'confirmed' (inventory) while engine_sync_status
  // drives the desk workflow; halls use their native 'tentative' state.
  const hallBookingCols = db.prepare("PRAGMA table_info(hall_bookings)").all().map(c => c.name);
  [
    ['engine_code', "TEXT"],        // tender code shown to the guest (unique, partial index below)
    ['engine_sync_status', "TEXT"], // pending → confirmed/rejected
  ].forEach(([col, def]) => { if (!hallBookingCols.includes(col)) db.exec(`ALTER TABLE hall_bookings ADD COLUMN ${col} ${def}`); });
  const poolBookingCols2 = db.prepare("PRAGMA table_info(pool_bookings)").all().map(c => c.name);
  [
    ['engine_code', "TEXT"],
    ['engine_sync_status', "TEXT"],
  ].forEach(([col, def]) => { if (!poolBookingCols2.includes(col)) db.exec(`ALTER TABLE pool_bookings ADD COLUMN ${col} ${def}`); });

  // bookings → full guest bio-data + group-account billing
  const bookingCols2 = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
  [
    ['surname', "TEXT"],
    ['first_name', "TEXT"],
    ['address', "TEXT"],
    ['id_type', "TEXT"],
    ['id_number', "TEXT"],
    ['country', "TEXT"],
    ['state', "TEXT"],
    ['next_of_kin_name', "TEXT"],
    ['next_of_kin_phone', "TEXT"],
    ['billed_to', "TEXT NOT NULL DEFAULT 'individual'"], // 'individual' | 'group'
    ['external_ref', "TEXT"],                            // OTA / channel reservation id (Booking.com, Expedia, …)
    ['prepaid', "INTEGER NOT NULL DEFAULT 0"],           // 1 = collected by the OTA channel, not at the desk
    ['engine_code', "TEXT"],                              // booking-engine tender code (guest presents at front desk; uniqueness via partial index below)
    ['engine_sync_status', "TEXT"],                       // booking-engine lifecycle: pending → confirmed/rejected
  ].forEach(([col, def]) => { if (!bookingCols2.includes(col)) db.exec(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`); });

  // transactions & pos_tickets → allow charging to a group booking's account instead of a single room
  const txnCols = db.prepare("PRAGMA table_info(transactions)").all().map(c => c.name);
  if (!txnCols.includes('booking_id')) db.exec("ALTER TABLE transactions ADD COLUMN booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL");
  if (!txnCols.includes('guest_id')) db.exec("ALTER TABLE transactions ADD COLUMN guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL");
  // Unified money pipeline (server/services/charges.js):
  //   idempotency_key — globally unique posting key (source + source row id).
  //     The UNIQUE index below is what makes duplicate charges structurally
  //     impossible, not just unlikely: a retried request or double-click
  //     returns the ORIGINAL transaction row.
  //   source          — which pipeline produced the money (booking, order,
  //     pos, misc_service, pool, hall). Drives revenue distribution.
  if (!txnCols.includes('idempotency_key')) db.exec("ALTER TABLE transactions ADD COLUMN idempotency_key TEXT");
  if (!txnCols.includes('source')) db.exec("ALTER TABLE transactions ADD COLUMN source TEXT");
  const posCols3 = db.prepare("PRAGMA table_info(pos_tickets)").all().map(c => c.name);
  if (!posCols3.includes('booking_id')) db.exec("ALTER TABLE pos_tickets ADD COLUMN booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL");
  if (!posCols3.includes('cashier_name')) db.exec("ALTER TABLE pos_tickets ADD COLUMN cashier_name TEXT");

  // users.role CHECK constraint → add accountant/auditor roles + permissions_customized flag.
  // SQLite can't alter a CHECK constraint in place, so rebuild the table.
  const usersTableSql2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (usersTableSql2 && !usersTableSql2.sql.includes('accountant')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE users_new (
        id TEXT PRIMARY KEY,
        tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('superadmin','hotel_admin','receptionist','staff','cashier','barman','accountant','auditor')),
        department TEXT,
        avatar TEXT,
        phone TEXT,
        active INTEGER DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        permissions TEXT NOT NULL DEFAULT '[]',
        permissions_customized INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users_new (id, tenant_id, name, email, password_hash, role, department, avatar, phone, active, last_login_at, created_at, permissions)
        SELECT id, tenant_id, name, email, password_hash, role, department, avatar, phone, active, last_login_at, created_at, permissions FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;
      CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id);
    `);
    db.pragma('foreign_keys = ON');
  }

  // ══════════════════════════════════════════════════════════
  // PERFORMANCE INDEXES — for frequently queried columns
  // ══════════════════════════════════════════════════════════
  
  const performanceIndexes = [
    // Bookings — common filter patterns
    ['idx_bookings_tenant_status', 'bookings', 'tenant_id, status'],
    ['idx_bookings_tenant_checkin', 'bookings', 'tenant_id, check_in'],
    ['idx_bookings_tenant_checkout', 'bookings', 'tenant_id, check_out'],
    ['idx_bookings_guest', 'bookings', 'tenant_id, guest_id'],
    ['idx_bookings_reference', 'bookings', 'reference'],
    
    // Booking rooms — join lookups
    ['idx_booking_rooms_booking', 'booking_rooms', 'booking_id'],
    ['idx_booking_rooms_room', 'booking_rooms', 'room_id'],
    
    // Transactions — financial queries
    ['idx_transactions_tenant_status', 'transactions', 'tenant_id, status'],
    ['idx_transactions_tenant_created', 'transactions', 'tenant_id, created_at'],
    ['idx_transactions_gateway_ref', 'transactions', 'gateway_ref'],
    
    // Guests — search optimization
    ['idx_guests_tenant_phone', 'guests', 'tenant_id, phone'],
    ['idx_guests_tenant_email', 'guests', 'tenant_id, email'],
    
    // Messages — conversation queries
    ['idx_messages_conversation', 'messages', 'conversation_id, created_at'],
    
    // Attendance — scheduling queries
    ['idx_attendance_staff_date', 'attendance', 'staff_id, date'],
    
    // Orders — status tracking
    ['idx_orders_tenant_status', 'orders', 'tenant_id, status'],
    ['idx_orders_tenant_created', 'orders', 'tenant_id, created_at'],
    
    // Menu items — POS. (The availability column is `available`, not `active`;
    // the old index named a non-existent column and was silently swallowed by the
    // try/catch below, so POS menu lookups were never actually indexed.)
    ['idx_menu_items_tenant', 'menu_items', 'tenant_id, available'],
    ['idx_menu_items_category', 'menu_items', 'tenant_id, category'],
    
    // Rooms — status queries
    ['idx_rooms_tenant_type', 'rooms', 'tenant_id, type'],
  ];
  
  performanceIndexes.forEach(([idxName, table, columns]) => {
    try {
      db.exec(`CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (${columns})`);
    } catch (e) {
      // A genuine mistake here (a column that does not exist) used to be swallowed
      // in silence, leaving a hot query unindexed with nothing to show for it. Warn.
      console.warn(`⚠️ Could not create index ${idxName} on ${table}(${columns}): ${e.message}`);
    }
  });

  // ── Uniqueness constraints that back idempotency ──────────────────────────
  // One conversation per (tenant, phone): the WhatsApp webhook relies on this for
  // its INSERT ... ON CONFLICT so two messages arriving together cannot fork two
  // conversation threads for the same guest.
  try {
    db.exec('DELETE FROM conversations WHERE rowid NOT IN (SELECT MIN(rowid) FROM conversations GROUP BY tenant_id, guest_phone)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_conv_tenant_phone ON conversations(tenant_id, guest_phone)');
  } catch (e) {
    console.warn('⚠️ Could not enforce unique conversation per phone:', e.message);
  }

  // One booking per engine tender code: the desk "confirm by code" lookup uses
  // this as the key, so two engine submissions can never share a code. Partial:
  // ordinary (front-desk-created) bookings keep NULL and don't participate.
  // Same guarantee for the facility channels (halls, pool).
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_bookings_engine_code ON bookings(engine_code) WHERE engine_code IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_hallbookings_engine_code ON hall_bookings(engine_code) WHERE engine_code IS NOT NULL');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_poolbookings_engine_code ON pool_bookings(engine_code) WHERE engine_code IS NOT NULL');
  } catch (e) {
    console.warn('⚠️ Could not enforce unique engine codes:', e.message);
  }

  // One transaction per gateway reference: the payment-gateway webhooks use this as
  // their idempotency key so a provider retry cannot record the same charge twice.
  try {
    db.exec(`DELETE FROM transactions WHERE gateway_ref IS NOT NULL AND rowid NOT IN (
               SELECT MIN(rowid) FROM transactions WHERE gateway_ref IS NOT NULL GROUP BY tenant_id, gateway_ref)`);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_txn_tenant_gateway_ref ON transactions(tenant_id, gateway_ref) WHERE gateway_ref IS NOT NULL');
  } catch (e) {
    console.warn('⚠️ Could not enforce unique gateway reference per transaction:', e.message);
  }

  // One posting per pipeline idempotency key — the structural guarantee behind
  // server/services/charges.js. Backfilled rows (pre-pipeline data) keep NULL
  // and don't participate in the index.
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_txn_idempotency_key ON transactions(idempotency_key) WHERE idempotency_key IS NOT NULL');
  } catch (e) {
    console.warn('⚠️ Could not enforce unique idempotency key:', e.message);
  }

  // ══════════════════════════════════════════════════════════
  // SAAS BILLING — platform plans, subscription requests, billing events
  // ══════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      tagline TEXT,
      price_monthly REAL NOT NULL DEFAULT 0,
      price_yearly REAL NOT NULL DEFAULT 0,
      max_rooms INTEGER,
      max_users INTEGER,
      max_properties INTEGER,
      daily_booking_cap INTEGER,
      features TEXT DEFAULT '[]',
      sort INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- One row per plan request/approval cycle. status:
    --   pending_approval → payment awaited
    --   active → approved & paid (only one per tenant)
    --   superseded → replaced by a newer cycle
    --   cancelled / rejected → withdrawn or declined
    CREATE TABLE IF NOT EXISTS platform_subscriptions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL,
      billing_cycle TEXT NOT NULL DEFAULT 'monthly' CHECK(billing_cycle IN ('monthly','yearly')),
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_approval'
        CHECK(status IN ('pending_approval','active','superseded','cancelled','rejected')),
      payment_reference TEXT UNIQUE,
      payment_method TEXT,
      gateway_ref TEXT,
      requested_by TEXT,
      approved_by TEXT,
      approved_at TEXT,
      period_start TEXT,
      period_end TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      requested_at TEXT DEFAULT (datetime('now'))
    );
-- ══════════════════════════════════════════════════════════
    -- PLATFORM SETTINGS — key/value store for platform-operator (superadmin)
    -- configuration: payment gateway credentials for automated subscription
    -- checkout (Stripe secret key, Paystack secret key), platform-wide
    -- defaults. Values that look like secrets are encrypted at rest with
    -- AES-256-GCM (crypto-store). Only superadmin routes ever read them.
    -- ══════════════════════════════════════════════════════════
    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

CREATE INDEX IF NOT EXISTS idx_platsub_tenant ON platform_subscriptions(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_platsub_pending ON platform_subscriptions(status, requested_at);

    -- Append-only billing trail: requests, approvals, expiry sweeps.
    CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      note TEXT,
      amount REAL,
      payment_reference TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_billevents_tenant ON billing_events(tenant_id, created_at);
  `);

  // ══════════════════════════════════════════════════════════
  // BLOCKED NUMBERS — per-tenant phone blocklist enforced at every public
  // entry point (self-OTA rooms, halls, pool). One row per phone per tenant.
  // ══════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked_numbers (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      reason TEXT,
      blocked_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tenant_id, phone)
    );
    CREATE INDEX IF NOT EXISTS idx_blocked_tenant ON blocked_numbers(tenant_id, phone);
  `);

  // tenants → SaaS trial + signup provenance
  const tenantCols3 = db.prepare("PRAGMA table_info(tenants)").all().map(c => c.name);
  [
    ['trial_started_at', 'TEXT'],
    ['trial_ends_at', 'TEXT'],
    ['signup_source', "TEXT NOT NULL DEFAULT 'direct'"], // 'direct' | 'checkout' | 'landing'
  ].forEach(([col, def]) => { if (!tenantCols3.includes(col)) db.exec(`ALTER TABLE tenants ADD COLUMN ${col} ${def}`); });

  // ══════════════════════════════════════════════════════════
  // IDEMPOTENCY KEYS — offline-first request replay protection.
  // One row per client-generated Idempotency-Key (scoped per tenant). The
  // offline PWA replays queued writes when the connection returns; the row
  // remembers that the key already executed (and stores the exact 2xx
  // response) so a replay can never create a second booking, guest, check-in
  // or settlement. Rows are cleaned up lazily after 48h by the middleware.
  // Purely additive — existing data untouched. See server/middleware/idempotency.js.
  // ══════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,             -- tenant_id + ':' + client key
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id TEXT,
      method TEXT NOT NULL,
      path TEXT,
      request_hash TEXT NOT NULL,       -- method+path+canonical body (mismatch → 409)
      status INTEGER,                   -- NULL = in flight; else stored response status
      response_body TEXT,               -- exact stored 2xx JSON response
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);
  `);

  // ══════════════════════════════════════════════════════════
  // PAYMENT GATEWAY CATALOG — backfill defaults on upgraded databases
  // ══════════════════════════════════════════════════════════
  // A database seeded before this catalog existed keeps an EMPTY
  // payment_gateways table (seed.js only runs on first boot), which made the
  // Super Admin "Payment Gateways" tab look absent in production. Insert the
  // same defaults seed.js uses — once, and only while the table is empty, so
  // rows the operator added, renamed or deliberately removed are never touched.
  if (db.prepare('SELECT COUNT(*) c FROM payment_gateways').get().c === 0) {
    const insGw = db.prepare('INSERT INTO payment_gateways (id, name, type, description) VALUES (?,?,?,?)');
    [['Bank Transfer', 'bank_transfer', 'Direct bank-to-bank transfer'],
     ['POS Terminal', 'pos', 'Card payment via physical POS terminal'],
     ['Cryptocurrency', 'crypto', 'BTC/USDT and other crypto payments'],
     ['PayPal', 'paypal', 'International guest payments via PayPal']]
      .forEach(([n, t, d]) => insGw.run('gw_' + nanoid(10), n, t, d));
    console.log('✓ Backfilled the default payment gateway catalog (table was empty)');
  }

  // ══════════════════════════════════════════════════════════
  // GYM — fitness-centre inventory (gyms) + member registrations
  // (gym_bookings). Each gym carries its facilities, type, capacity and the
  // daily/monthly/yearly registration prices a member pays. Registrations are
  // date-ranged memberships ([start_date, end_date] inclusive) with per-gym
  // capacity enforcement over overlapping periods. Purely additive — existing
  // tables untouched. See server/routes/gym.js.
  // ══════════════════════════════════════════════════════════
  db.exec(`
    CREATE TABLE IF NOT EXISTS gyms (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Standard',
      facilities TEXT DEFAULT '[]',
      description TEXT,
      capacity INTEGER NOT NULL DEFAULT 20,
      price_daily REAL NOT NULL DEFAULT 0,
      price_monthly REAL NOT NULL DEFAULT 0,
      price_yearly REAL NOT NULL DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gyms_tenant ON gyms(tenant_id);

    CREATE TABLE IF NOT EXISTS gym_bookings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      gym_id TEXT NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
      member_name TEXT NOT NULL,
      member_phone TEXT,
      member_email TEXT,
      room_number TEXT,
      registration_type TEXT NOT NULL DEFAULT 'daily' CHECK(registration_type IN ('daily','monthly','yearly')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      paid INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
      notes TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_gymbookings_tenant ON gym_bookings(tenant_id, start_date);
    CREATE INDEX IF NOT EXISTS idx_gymbookings_gym ON gym_bookings(gym_id, start_date);
  `);

  // ══════════════════════════════════════════════════════════
  // ANALYZE — Update query planner statistics
  // ══════════════════════════════════════════════════════════
  try {
    db.exec('ANALYZE');
  } catch (e) {
    // ANALYZE may not be supported in all SQLite versions
  }

  console.log('✓ Database schema migrated successfully');
  console.log('✓ Performance indexes applied');
}

migrate();
module.exports = migrate;
