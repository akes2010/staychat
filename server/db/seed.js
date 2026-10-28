// server/db/seed.js
// Populates the database with realistic demo data for first-run / demo mode.
// Safe to re-run: it checks if tenants already exist and skips if so, unless
// FORCE_SEED=1 is set — in which case it wipes every table first, then
// reseeds from scratch (so re-running it never hits stale UNIQUE constraints).
'use strict';

require('dotenv').config(); // so DEMO_PASSWORD from .env applies at seed time too
require('./migrate');
const db = require('./connection');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { isDesk } = require('../utils/edition');

// bcrypt rounds - higher is more secure but slower
const BCRYPT_ROUNDS = 12;

function id(prefix) { return prefix + '_' + nanoid(10); }

function seed() {
  // The Desk edition (desktop app) has no platform operator: it must never
  // seed a superadmin, and any left behind by an earlier desktop install is
  // removed here so the Super Admin console can't come back. This runs on
  // every boot — the tenants-exist skip below returns for existing databases.
  if (isDesk()) {
    const removed = db.prepare("DELETE FROM users WHERE role = 'superadmin'").run();
    if (removed.changes) console.log('→ Desk edition: removed ' + removed.changes + ' superadmin login(s)');
  }
  const existing = db.prepare('SELECT COUNT(*) as c FROM tenants').get();
  if (existing.c > 0 && process.env.FORCE_SEED !== '1') {
    console.log('• Tenants already exist — skipping seed (set FORCE_SEED=1 to force).');
    return;
  }
  if (existing.c > 0 && process.env.FORCE_SEED === '1') {
    console.log('→ FORCE_SEED=1 — wiping existing data first...');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    db.pragma('foreign_keys = OFF');
    const wipe = db.transaction(() => { tables.forEach(t => db.prepare(`DELETE FROM ${t}`).run()); });
    wipe();
    db.pragma('foreign_keys = ON');
    console.log('✓ Wiped ' + tables.length + ' tables');
  }

  console.log('→ Seeding database with demo data...');
  console.log('→ Hashing passwords (this may take a moment)...');

  // Generate password hash - using environment variable for demo password
  // In production, always use strong passwords via environment configuration
  const demoPassword = process.env.DEMO_PASSWORD || 'Demo@123456';
  const passwordHash = bcrypt.hashSync(demoPassword, BCRYPT_ROUNDS);

  // ── TENANTS ──────────────────────────────────────────────────────────────
  const t1 = id('tenant'); // Hospitally Grand Resort
  const t2 = id('tenant'); // Azure Beach Hotel
  const t3 = id('tenant'); // Savanna Lodge

  const insertTenant = db.prepare(`
    INSERT INTO tenants (id, name, subdomain, plan, status, country, email, phone, currency, timezone,
      check_in_time, check_out_time, mrr, ai_enabled, ai_tone, wa_phone, wa_connected,
      paystack_public_key, stripe_public_key)
    VALUES (@id,@name,@subdomain,@plan,@status,@country,@email,@phone,@currency,@timezone,
      @check_in_time,@check_out_time,@mrr,@ai_enabled,@ai_tone,@wa_phone,@wa_connected,
      @paystack_public_key,@stripe_public_key)
  `);

  insertTenant.run({ id:t1, name:'Hospitally Grand Resort', subdomain:'hospitally', plan:'enterprise', status:'active', country:'Nigeria', email:'admin@hospitally.com', phone:'+234 801 234 5678', currency:'$', timezone:'UTC+1', check_in_time:'14:00', check_out_time:'11:00', mrr:199, ai_enabled:1, ai_tone:'Professional', wa_phone:'+234 801 234 5678', wa_connected:1, paystack_public_key:'pk_test_demo', stripe_public_key:'pk_test_demo' });
  insertTenant.run({ id:t2, name:'Azure Beach Hotel', subdomain:'azure-beach', plan:'pro', status:'active', country:'Ghana', email:'admin@azurebeach.com', phone:'+233 24 567 8901', currency:'$', timezone:'UTC', check_in_time:'15:00', check_out_time:'12:00', mrr:79, ai_enabled:1, ai_tone:'Friendly', wa_phone:'+233 24 567 8901', wa_connected:1, paystack_public_key:'pk_test_demo2', stripe_public_key:null });
  insertTenant.run({ id:t3, name:'Savanna Lodge', subdomain:'savanna', plan:'starter', status:'active', country:'Kenya', email:'admin@savannalodge.com', phone:'+254 712 345 678', currency:'$', timezone:'UTC+3', check_in_time:'14:00', check_out_time:'10:00', mrr:29, ai_enabled:0, ai_tone:'Professional', wa_phone:null, wa_connected:0, paystack_public_key:null, stripe_public_key:null });

  // ── USERS ────────────────────────────────────────────────────────────────
  const insertUser = db.prepare(`
    INSERT INTO users (id, tenant_id, name, email, password_hash, role, department, avatar, phone, active)
    VALUES (@id,@tenant_id,@name,@email,@password_hash,@role,@department,@avatar,@phone,1)
  `);
  // Hosted edition only — the desktop app has no superadmin (see isDesk above).
  if (!isDesk()) {
    insertUser.run({ id:id('user'), tenant_id:null, name:'Super Admin', email:'superadmin@staychat.io', password_hash:passwordHash, role:'superadmin', department:null, avatar:'SA', phone:null });
  }
  const adminUserId = id('user');
  // Booking engine ON for every seeded hotel — mirrors what signup does for
  // real tenants, so a freshly seeded deployment has the demo booking funnel
  // (book.html → pending desk queue → confirm → check-in) fully usable.
  // (Runs after all three tenants exist — booking_engine_config rows FK to tenants.)
  const insertEngineCfg = db.prepare(`
    INSERT INTO booking_engine_config (tenant_id, enabled, notice, max_daily)
    VALUES (?, 1, NULL, 50)
    ON CONFLICT(tenant_id) DO UPDATE SET enabled = 1
  `);
  insertEngineCfg.run(t1); insertEngineCfg.run(t2); insertEngineCfg.run(t3);

  insertUser.run({ id:adminUserId, tenant_id:t1, name:'John Manager', email:'admin@hospitally.com', password_hash:passwordHash, role:'hotel_admin', department:null, avatar:'JM', phone:'+1 555 0001' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Priya Sharma', email:'reception@hospitally.com', password_hash:passwordHash, role:'receptionist', department:'Front Desk', avatar:'PS', phone:'+1 555 0108' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Emeka Obi', email:'porter@hospitally.com', password_hash:passwordHash, role:'porter', department:'Front Office', avatar:'EO', phone:'+1 555 0127' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Felix Zhang', email:'felix@hospitally.com', password_hash:passwordHash, role:'staff', department:'Housekeeping', avatar:'FZ', phone:'+1 555 0101' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Marcus Bello', email:'cashier@hospitally.com', password_hash:passwordHash, role:'cashier', department:'Restaurant POS', avatar:'MB', phone:'+1 555 0121' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Diane Okoro', email:'barman@hospitally.com', password_hash:passwordHash, role:'barman', department:'Bar POS', avatar:'DO', phone:'+1 555 0122' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Tunde Ayo', email:'waiter@hospitally.com', password_hash:passwordHash, role:'waiter', department:'Bar Floor', avatar:'TA', phone:'+1 555 0125' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Sade Bello', email:'server@hospitally.com', password_hash:passwordHash, role:'server', department:'Restaurant Floor', avatar:'SB', phone:'+1 555 0126' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Grace Nnamdi', email:'accountant@hospitally.com', password_hash:passwordHash, role:'accountant', department:'Accounts', avatar:'GN', phone:'+1 555 0123' });
  insertUser.run({ id:id('user'), tenant_id:t1, name:'Samuel Okoye', email:'auditor@hospitally.com', password_hash:passwordHash, role:'auditor', department:'Internal Audit', avatar:'SO', phone:'+1 555 0124' });
  insertUser.run({ id:id('user'), tenant_id:t2, name:'Azure Admin', email:'admin@azurebeach.com', password_hash:passwordHash, role:'hotel_admin', department:null, avatar:'AA', phone:'+233 24 000 0000' });

  // ── ROOMS (Tenant 1) ─────────────────────────────────────────────────────
  const insertRoom = db.prepare(`
    INSERT INTO rooms (id, tenant_id, number, type, view, floor, rate, capacity, status, guest_name, checkout_label, issue, amenities)
    VALUES (@id,@tenant_id,@number,@type,@view,@floor,@rate,@capacity,@status,@guest_name,@checkout_label,@issue,@amenities)
  `);
  const rooms = [
    ['101','Deluxe King','Ocean View',1,125,2,'available',null,null,null,'["AC","TV","WiFi","Mini-bar"]'],
    ['102','Standard Twin','City View',1,89,2,'occupied','Mr. Anderson','Oct 26',null,'["AC","TV","WiFi"]'],
    ['103','Suite','Terrace',1,200,4,'dirty',null,null,null,'["AC","TV","WiFi","Jacuzzi","Mini-bar"]'],
    ['104','Standard King','Internal',1,95,2,'maintenance',null,null,'AC Repair','["AC","TV","WiFi"]'],
    ['105','Standard King','City View',1,95,2,'available',null,null,null,'["AC","TV","WiFi"]'],
    ['106','Superior Twin','Garden',1,110,2,'occupied','Ms. Chen','Oct 24 11:00',null,'["AC","TV","WiFi","Bathtub"]'],
    ['107','Executive Suite','Sea View',1,180,2,'dirty',null,null,null,'["AC","TV","WiFi","Jacuzzi","Lounge"]'],
    ['108','Penthouse Loft','Panoramic',2,350,4,'available',null,null,null,'["AC","TV","WiFi","Jacuzzi","Terrace","Butler"]'],
    ['109','Economy Double','Courtyard',2,75,2,'occupied','Ms. Smith','Oct 25',null,'["AC","TV","WiFi"]'],
    ['110','Standard Twin','Pool View',2,89,2,'dirty',null,null,null,'["AC","TV","WiFi"]'],
    ['201','Deluxe Double','Ocean View',2,130,2,'available',null,null,null,'["AC","TV","WiFi","Mini-bar"]'],
    ['202','Family Suite','Garden',2,220,6,'occupied','Johnson Family','Oct 27',null,'["AC","TV","WiFi","2xBathrooms"]'],
    ['203','Standard King','City View',2,95,2,'available',null,null,null,'["AC","TV","WiFi"]'],
    ['204','Junior Suite','Sea View',2,160,2,'occupied','Mr. Williams','Oct 26',null,'["AC","TV","WiFi","Lounge"]'],
    ['205','Standard Twin','Courtyard',2,89,2,'maintenance',null,null,'Plumbing leak','["AC","TV","WiFi"]'],
  ];
  rooms.forEach(r => insertRoom.run({ id:id('room'), tenant_id:t1, number:r[0], type:r[1], view:r[2], floor:r[3], rate:r[4], capacity:r[5], status:r[6], guest_name:r[7], checkout_label:r[8], issue:r[9], amenities:r[10] }));

  // A handful of rooms for tenant 2 & 3 so super-admin demo isn't empty
  ['301','302','303'].forEach((num,i) => insertRoom.run({ id:id('room'), tenant_id:t2, number:num, type:'Standard', view:'Sea View', floor:1, rate:90+i*10, capacity:2, status:i===0?'occupied':'available', guest_name:i===0?'Test Guest':null, checkout_label:null, issue:null, amenities:'["AC","WiFi"]' }));
  ['1','2'].forEach((num,i) => insertRoom.run({ id:id('room'), tenant_id:t3, number:num, type:'Safari Tent', view:'Savanna', floor:1, rate:60, capacity:2, status:'available', guest_name:null, checkout_label:null, issue:null, amenities:'["Fan"]' }));

  // ── GUESTS ───────────────────────────────────────────────────────────────
  const insertGuest = db.prepare(`
    INSERT INTO guests (id, tenant_id, name, phone, email, room_number, loyalty_tier, loyalty_points, stays, total_spent, preferences, check_in_date, check_out_date)
    VALUES (@id,@tenant_id,@name,@phone,@email,@room_number,@loyalty_tier,@loyalty_points,@stays,@total_spent,@preferences,@check_in_date,@check_out_date)
  `);
  const guestRows = [
    ['Mr. Anderson','+1 555 1001','anderson@email.com','102','Silver',1240,4,890,'["City View","King Bed"]','Oct 23','Oct 26'],
    ['Ms. Chen','+1 555 1002','chen@email.com','106','Gold',5800,9,2340,'["Garden View","Twin Bed","Late Checkout"]','Oct 22','Oct 24'],
    ['Johnson Family','+1 555 1003','johnson@email.com','202','Bronze',320,2,660,'["Large Room","Family Suite"]','Oct 24','Oct 27'],
    ['Mr. Williams','+1 555 1004','williams@email.com','204','Platinum',18400,22,8920,'["Sea View","Suite","Extra Pillows","Daily Spa"]','Oct 23','Oct 26'],
    ['Ms. Smith','+1 555 1005','smith@email.com','109','Bronze',180,1,225,'["Quiet Room"]','Oct 24','Oct 25'],
  ];
  const guestIds = {};
  guestRows.forEach(g => {
    const gid = id('guest');
    guestIds[g[0]] = gid;
    insertGuest.run({ id:gid, tenant_id:t1, name:g[0], phone:g[1], email:g[2], room_number:g[3], loyalty_tier:g[4], loyalty_points:g[5], stays:g[6], total_spent:g[7], preferences:g[8], check_in_date:g[9], check_out_date:g[10] });
  });

  // ── MENU ─────────────────────────────────────────────────────────────────
  const insertMenu = db.prepare(`INSERT INTO menu_items (id, tenant_id, name, category, price, description, available, outlet) VALUES (@id,@tenant_id,@name,@category,@price,@description,@available,@outlet)`);
  const menuRows = [
    ['Jollof Rice','Mains',12,'West African spiced rice',1,'both'],
    ['Fried Rice','Mains',10,'Stir-fried rice with vegetables',1,'both'],
    ['Grilled Chicken','Mains',18,'Herb-marinated grilled chicken',1,'restaurant'],
    ['Burger & Fries','Mains',15,'Classic beef burger with crispy fries',1,'both'],
    ['Caesar Salad','Salads',11,'Romaine lettuce, croutons, parmesan',0,'restaurant'],
    ['Club Sandwich','Snacks',12,'Triple-decker with chicken & bacon',1,'both'],
    ['Chocolate Cake','Desserts',8,'Rich chocolate layer cake',1,'restaurant'],
    ['Ice Cream (3 scoops)','Desserts',6,'Vanilla, chocolate, strawberry',1,'restaurant'],
    ['Coke / Sprite','Drinks',3,'330ml can',1,'both'],
    ['Bottled Water','Drinks',2,'500ml still water',1,'both'],
    ['Fresh Juice','Drinks',5,'Orange, mango, or pineapple',1,'both'],
    ['Coffee / Tea','Drinks',4,'Brewed coffee or herbal tea',1,'restaurant'],
    ['Continental Breakfast','Mains',18,'Eggs, toast, juice, coffee',1,'restaurant'],
    ['Kids Meal','Mains',10,'Nuggets, fries, juice box',1,'restaurant'],
    ['Mojito','Cocktails',9,'White rum, mint, lime, soda',1,'bar'],
    ['Margarita','Cocktails',10,'Tequila, triple sec, lime',1,'bar'],
    ['Old Fashioned','Cocktails',12,'Bourbon, bitters, sugar, orange twist',1,'bar'],
    ['House Red / White Wine','Wine',8,'Glass, ask for today\'s selection',1,'bar'],
    ['Local Lager','Beer',5,'500ml draft',1,'bar'],
    ['Whisky (Single)','Spirits',9,'Choice of house whisky',1,'bar'],
    ['Bar Snack Mix','Bar Snacks',6,'Nuts, plantain chips, pretzels',1,'bar'],
  ];
  menuRows.forEach(m => insertMenu.run({ id:id('menu'), tenant_id:t1, name:m[0], category:m[1], price:m[2], description:m[3], available:m[4], outlet:m[5] }));

  // ── STAFF ────────────────────────────────────────────────────────────────
  const insertStaff = db.prepare(`
    INSERT INTO staff (id, tenant_id, name, role, department, shift, phone, email, status, tasks_completed, avg_time, joined_date)
    VALUES (@id,@tenant_id,@name,@role,@department,@shift,@phone,@email,@status,@tasks_completed,@avg_time,@joined_date)
  `);
  const staffRows = [
    ['Felix Zhang','Housekeeper','Housekeeping','Morning','+1 555 0101','felix@hotel.com','active',34,'12m','2023-06-15'],
    ['Sara Miller','HK Lead','Housekeeping','Morning','+1 555 0102','sara@hotel.com','active',29,'22m','2022-11-20'],
    ['Marko Devic','Head Chef','Kitchen','Morning','+1 555 0103','marko@hotel.com','active',27,'8m','2023-01-08'],
    ['Elena Vance','Floor Lead','Housekeeping','Afternoon','+1 555 0104','elena@hotel.com','active',22,'18m','2023-04-12'],
    ['Marcus Thorne','Concierge','Front Desk','Morning','+1 555 0105','marcus@hotel.com','active',18,'5m','2022-08-30'],
    ['Sarah Jenkins','Maintenance Lead','Maintenance','Morning','+1 555 0106','sarah@hotel.com','busy',15,'45m','2023-02-14'],
    ['James Park','Sous Chef','Kitchen','Morning','+1 555 0107','james@hotel.com','break',12,'10m','2023-09-01'],
    ['Priya Sharma','Receptionist','Front Desk','Morning','+1 555 0108','priya@hotel.com','active',25,'3m','2023-03-22'],
  ];
  staffRows.forEach(s => insertStaff.run({ id:id('staff'), tenant_id:t1, name:s[0], role:s[1], department:s[2], shift:s[3], phone:s[4], email:s[5], status:s[6], tasks_completed:s[7], avg_time:s[8], joined_date:s[9] }));

  // ── MAINTENANCE ──────────────────────────────────────────────────────────
  const insertMaint = db.prepare(`INSERT INTO maintenance_requests (id, tenant_id, room_number, issue, priority, status, assignee) VALUES (@id,@tenant_id,@room_number,@issue,@priority,@status,@assignee)`);
  insertMaint.run({ id:id('maint'), tenant_id:t1, room_number:'104', issue:'AC not cooling properly — grinding noise', priority:'high', status:'in-progress', assignee:'Sarah Jenkins' });
  insertMaint.run({ id:id('maint'), tenant_id:t1, room_number:'205', issue:'Bathroom tap leaking heavily', priority:'high', status:'pending', assignee:null });
  insertMaint.run({ id:id('maint'), tenant_id:t1, room_number:'108', issue:'TV remote not responding', priority:'low', status:'completed', assignee:'James Park' });
  insertMaint.run({ id:id('maint'), tenant_id:t1, room_number:'106', issue:'Window latch broken — cannot lock', priority:'medium', status:'pending', assignee:null });

  // ── ORDERS ───────────────────────────────────────────────────────────────
  const insertOrder = db.prepare(`INSERT INTO orders (id, tenant_id, room_number, guest_name, items, total, status, note, paid) VALUES (@id,@tenant_id,@room_number,@guest_name,@items,@total,@status,@note,@paid)`);
  insertOrder.run({ id:id('order'), tenant_id:t1, room_number:'204', guest_name:'Mr. Williams', items:JSON.stringify([{name:'Fried Rice',qty:1,price:12},{name:'Coke',qty:1,price:3}]), total:15, status:'preparing', note:'No spice please', paid:1 });
  insertOrder.run({ id:id('order'), tenant_id:t1, room_number:'102', guest_name:'Mr. Anderson', items:JSON.stringify([{name:'Club Sandwich',qty:1,price:12}]), total:12, status:'delivered', note:null, paid:1 });
  insertOrder.run({ id:id('order'), tenant_id:t1, room_number:'106', guest_name:'Ms. Chen', items:JSON.stringify([{name:'Continental Breakfast',qty:2,price:18}]), total:36, status:'pending', note:null, paid:0 });
  insertOrder.run({ id:id('order'), tenant_id:t1, room_number:'202', guest_name:'Johnson Family', items:JSON.stringify([{name:'Kids Meal',qty:2,price:10},{name:'Burger & Fries',qty:2,price:15}]), total:50, status:'pending', note:null, paid:1 });
  insertOrder.run({ id:id('order'), tenant_id:t1, room_number:'109', guest_name:'Ms. Smith', items:JSON.stringify([{name:'Coffee',qty:1,price:4},{name:'Bottled Water',qty:2,price:2}]), total:8, status:'delivered', note:null, paid:1 });

  // ── POS TICKETS (Restaurant & Bar) ─────────────────────────────────────
  const insertPos = db.prepare(`INSERT INTO pos_tickets (id, tenant_id, outlet, label, guest_name, room_number, items, subtotal, discount_pct, service_pct, tax_pct, total, status, payment_method, transaction_id, opened_by, closed_by, closed_at)
    VALUES (@id,@tenant_id,@outlet,@label,@guest_name,@room_number,@items,@subtotal,@discount_pct,@service_pct,@tax_pct,@total,@status,@payment_method,@transaction_id,@opened_by,@closed_by,@closed_at)`);
  insertPos.run({ id:id('pos'), tenant_id:t1, outlet:'restaurant', label:'Table 5', guest_name:'Ms. Chen', room_number:'106',
    items:JSON.stringify([{id:'i1',name:'Grilled Chicken',price:18,qty:2},{id:'i2',name:'Fresh Juice',price:5,qty:2}]),
    subtotal:46, discount_pct:0, service_pct:0, tax_pct:0, total:46, status:'open', payment_method:null, transaction_id:null, opened_by:'Priya Sharma', closed_by:null, closed_at:null });
  insertPos.run({ id:id('pos'), tenant_id:t1, outlet:'bar', label:'Bar Seat 2', guest_name:'Mr. Williams', room_number:'204',
    items:JSON.stringify([{id:'i1',name:'Mojito',price:9,qty:2},{id:'i2',name:'Bar Snack Mix',price:6,qty:1}]),
    subtotal:24, discount_pct:0, service_pct:0, tax_pct:0, total:24, status:'open', payment_method:null, transaction_id:null, opened_by:'Priya Sharma', closed_by:null, closed_at:null });
  insertPos.run({ id:id('pos'), tenant_id:t1, outlet:'restaurant', label:'Table 2', guest_name:'Walk-in', room_number:null,
    items:JSON.stringify([{id:'i1',name:'Burger & Fries',price:15,qty:1},{id:'i2',name:'Coke / Sprite',price:3,qty:1}]),
    subtotal:18, discount_pct:0, service_pct:0, tax_pct:0, total:18, status:'closed', payment_method:'cash', transaction_id:null, opened_by:'Priya Sharma', closed_by:'Priya Sharma', closed_at:new Date().toISOString() });

  // ── BOOKINGS & RESERVATIONS (single + group/multi-room) ─────────────────
  const t1Rooms = db.prepare("SELECT * FROM rooms WHERE tenant_id = ? AND status = 'available' ORDER BY number").all(t1);
  const insertBooking = db.prepare(`INSERT INTO bookings (id, tenant_id, guest_id, reference, check_in, check_out, status, total_amount, paid_amount, notes,
    guest_name, guest_phone, guest_email, is_group, group_name, adults, children, source, deposit_amount, created_by)
    VALUES (@id,@tenant_id,@guest_id,@reference,@check_in,@check_out,@status,@total_amount,@paid_amount,@notes,
    @guest_name,@guest_phone,@guest_email,@is_group,@group_name,@adults,@children,@source,@deposit_amount,@created_by)`);
  const insertBookingRoom = db.prepare(`INSERT INTO booking_rooms (id, tenant_id, booking_id, room_id, room_number, rate, occupant_name) VALUES (?,?,?,?,?,?,?)`);
  const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  if (t1Rooms.length >= 3) {
    const groupBookingId = id('bk');
    insertBooking.run({ id: groupBookingId, tenant_id: t1, guest_id: null, reference: 'BK-DEMO01-100', check_in: inDays(3), check_out: inDays(6),
      status: 'confirmed', total_amount: (t1Rooms[0].rate + t1Rooms[1].rate) * 3, paid_amount: 0, notes: 'Family reunion — needs adjoining rooms',
      guest_name: 'Rotimi Adeyemi', guest_phone: '+234 803 555 0110', guest_email: 'rotimi@example.com', is_group: 1,
      group_name: 'Adeyemi Family Reunion', adults: 4, children: 2, source: 'phone', deposit_amount: 100, created_by: 'Priya Sharma' });
    insertBookingRoom.run('bkr_' + id('x'), t1, groupBookingId, t1Rooms[0].id, t1Rooms[0].number, t1Rooms[0].rate, null);
    insertBookingRoom.run('bkr_' + id('x'), t1, groupBookingId, t1Rooms[1].id, t1Rooms[1].number, t1Rooms[1].rate, null);

    const singleBookingId = id('bk');
    insertBooking.run({ id: singleBookingId, tenant_id: t1, guest_id: null, reference: 'BK-DEMO02-200', check_in: inDays(1), check_out: inDays(4),
      status: 'confirmed', total_amount: t1Rooms[2].rate * 3, paid_amount: t1Rooms[2].rate, notes: null,
      guest_name: 'Grace Okafor', guest_phone: '+234 802 555 0199', guest_email: null, is_group: 0,
      group_name: null, adults: 1, children: 0, source: 'whatsapp', deposit_amount: 0, created_by: 'Priya Sharma' });
    insertBookingRoom.run('bkr_' + id('x'), t1, singleBookingId, t1Rooms[2].id, t1Rooms[2].number, t1Rooms[2].rate, null);

    // Ledger consistency: back the seeded deposit with a matching completed transaction
    // (bookings.paid_amount must always be explainable by the transactions table).
    db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref, booking_id)
                VALUES (?,?,?,?,?,?,?, 'completed', ?, ?)`)
      .run(id('txn'), t1, 'Grace Okafor', t1Rooms[2].number, 'Deposit — reservation BK-DEMO02-200', t1Rooms[2].rate, 'Card', 'SEED-DEP02', singleBookingId);
  }

  // ── HALLS & EVENT BOOKINGS ────────────────────────────────────────────
  const insertHall = db.prepare(`INSERT INTO halls (id, tenant_id, name, capacity, hourly_rate, day_rate, amenities) VALUES (@id,@tenant_id,@name,@capacity,@hourly_rate,@day_rate,@amenities)`);
  const hallGrand = id('hall'), hallGarden = id('hall'), hallBoard = id('hall');
  insertHall.run({ id: hallGrand, tenant_id: t1, name: 'Grand Ballroom', capacity: 250, hourly_rate: 150, day_rate: 900, amenities: JSON.stringify(['Stage','AV System','Dance Floor','Bridal Suite']) });
  insertHall.run({ id: hallGarden, tenant_id: t1, name: 'Garden Pavilion', capacity: 100, hourly_rate: 90, day_rate: 500, amenities: JSON.stringify(['Outdoor','Gazebo','String Lights']) });
  insertHall.run({ id: hallBoard, tenant_id: t1, name: 'Boardroom A', capacity: 20, hourly_rate: 40, day_rate: 220, amenities: JSON.stringify(['Projector','Video Conferencing','Whiteboard']) });

  const insertHallBooking = db.prepare(`INSERT INTO hall_bookings (id, tenant_id, hall_id, event_name, event_type, organizer_name, organizer_phone, organizer_email,
    event_date, start_time, end_time, guest_count, setup_style, catering, total_amount, deposit_amount, status, notes, created_by)
    VALUES (@id,@tenant_id,@hall_id,@event_name,@event_type,@organizer_name,@organizer_phone,@organizer_email,
    @event_date,@start_time,@end_time,@guest_count,@setup_style,@catering,@total_amount,@deposit_amount,@status,@notes,@created_by)`);
  insertHallBooking.run({ id: id('hb'), tenant_id: t1, hall_id: hallGrand, event_name: 'Bello-Fashola Wedding Reception', event_type: 'Wedding',
    organizer_name: 'Kemi Bello', organizer_phone: '+234 805 555 0142', organizer_email: 'kemi@example.com', event_date: inDays(10),
    start_time: '16:00', end_time: '23:00', guest_count: 180, setup_style: 'Banquet', catering: 1, total_amount: 2200, deposit_amount: 500,
    status: 'confirmed', notes: 'Requires stage and dance floor setup by 2pm', created_by: 'John Manager' });
  insertHallBooking.run({ id: id('hb'), tenant_id: t1, hall_id: hallBoard, event_name: 'Q3 Strategy Offsite', event_type: 'Corporate',
    organizer_name: 'Acme Logistics Ltd', organizer_phone: '+234 701 555 0177', organizer_email: null, event_date: inDays(4),
    start_time: '09:00', end_time: '13:00', guest_count: 14, setup_style: 'U-Shape', catering: 0, total_amount: 160, deposit_amount: 0,
    status: 'tentative', notes: null, created_by: 'Priya Sharma' });

  // ── POOLS (categorized areas) ────────────────────────────────────────
  const insertPoolArea = db.prepare(`INSERT INTO pools (id, tenant_id, name, category, description, price, capacity) VALUES (?,?,?,?,?,?,?)`);
  const poolMain = id('pool'), poolKids = id('pool'), poolVip = id('pool');
  insertPoolArea.run(poolMain, t1, 'Main Pool', 'Standard', 'Large outdoor pool with sun loungers', 0, 30);
  insertPoolArea.run(poolKids, t1, 'Kids Pool', 'Kids', 'Shallow, safe pool for children under 12', 0, 15);
  insertPoolArea.run(poolVip, t1, 'VIP Cabana', 'VIP', 'Private cabana with dedicated service', 40, 6);

  // ── POOL BOOKINGS ─────────────────────────────────────────────────────
  const todayStr = new Date().toISOString().slice(0, 10);
  const insertPool = db.prepare(`INSERT INTO pool_bookings (id, tenant_id, guest_name, guest_phone, room_number, date, start_time, end_time, party_size, area, pool_id, price, paid, status, created_by)
    VALUES (@id,@tenant_id,@guest_name,@guest_phone,@room_number,@date,@start_time,@end_time,@party_size,@area,@pool_id,@price,@paid,@status,@created_by)`);
  insertPool.run({ id: id('poolbk'), tenant_id: t1, guest_name: 'Ms. Chen', guest_phone: null, room_number: '106', date: todayStr,
    start_time: '10:00', end_time: '12:00', party_size: 2, area: 'Main Pool', pool_id: poolMain, price: 0, paid: 1, status: 'confirmed', created_by: 'Priya Sharma' });
  insertPool.run({ id: id('poolbk'), tenant_id: t1, guest_name: 'Mr. Williams', guest_phone: '+1 555 0126', room_number: '204', date: todayStr,
    start_time: '14:00', end_time: '16:00', party_size: 4, area: 'VIP Cabana', pool_id: poolVip, price: 40, paid: 0, status: 'confirmed', created_by: 'Priya Sharma' });

  // ── FLOORS ────────────────────────────────────────────────────────────
  const insertFloor = db.prepare(`INSERT INTO floors (id, tenant_id, number, name, description) VALUES (?,?,?,?,?)`);
  insertFloor.run(id('floor'), t1, 1, 'Ground Floor', 'Lobby, restaurant, and standard rooms');
  insertFloor.run(id('floor'), t1, 2, '2nd Floor — Deluxe Wing', 'Deluxe rooms with balcony access');

  // ── ROOM CATEGORIES (tiered pricing incl. festive) ──────────────────────
  const insertRoomCat = db.prepare(`INSERT INTO room_categories (id, tenant_id, name, description, weekday_rate, weekend_rate, holiday_rate, festive_rate, discount_pct, capacity, amenities)
    VALUES (@id,@tenant_id,@name,@description,@weekday_rate,@weekend_rate,@holiday_rate,@festive_rate,@discount_pct,@capacity,@amenities)`);
  insertRoomCat.run({ id: id('roomcat'), tenant_id: t1, name: 'Standard', description: 'Comfortable and compact', weekday_rate: 120, weekend_rate: 140, holiday_rate: 170, festive_rate: 210, discount_pct: 0, capacity: 2, amenities: JSON.stringify(['AC','TV','WiFi']) });
  insertRoomCat.run({ id: id('roomcat'), tenant_id: t1, name: 'Deluxe', description: 'Spacious with premium furnishings', weekday_rate: 180, weekend_rate: 210, holiday_rate: 260, festive_rate: 320, discount_pct: 10, capacity: 3, amenities: JSON.stringify(['AC','TV','WiFi','Minibar','Balcony']) });

  // ── HOLIDAYS & FESTIVE DATES ───────────────────────────────────────────
  const insertHoliday = db.prepare(`INSERT INTO holidays (id, tenant_id, date, name, type) VALUES (?,?,?,?,?)`);
  insertHoliday.run(id('hol'), t1, inDays(14), 'Public Holiday', 'holiday');
  insertHoliday.run(id('hol'), t1, inDays(45), 'New Year\'s Eve', 'festive');

  // ── SHIFTS & ATTENDANCE ──────────────────────────────────────────────
  const insertShift = db.prepare(`INSERT INTO shifts (id, tenant_id, name, start_time, end_time, department) VALUES (?,?,?,?,?,?)`);
  const shiftMorning = id('shift'), shiftEvening = id('shift');
  insertShift.run(shiftMorning, t1, 'Morning', '07:00', '15:00', 'All');
  insertShift.run(shiftEvening, t1, 'Evening', '15:00', '23:00', 'All');

  const staffForAttendance = db.prepare('SELECT * FROM staff WHERE tenant_id = ? LIMIT 2').all(t1);
  const insertAttendance = db.prepare(`INSERT INTO attendance (id, tenant_id, staff_id, staff_name, shift_id, date, clock_in, status) VALUES (?,?,?,?,?,?,?,?)`);
  staffForAttendance.forEach((s, i) => insertAttendance.run(id('att'), t1, s.id, s.name, shiftMorning, todayStr, i === 0 ? '07:05' : '07:22', i === 0 ? 'present' : 'late'));

  // ── SUBSCRIPTION PLANS (platform-wide, superadmin-managed) ──────────────
  const insertPlan = db.prepare(`INSERT INTO plans (id, name, description, price_monthly, price_yearly, features) VALUES (?,?,?,?,?,?)`);
  insertPlan.run(id('plan'), 'Starter', 'Small independent hotels & guesthouses', 29, 290, JSON.stringify(['Up to 20 rooms', 'WhatsApp Inbox', 'Basic POS', 'Email support']));
  insertPlan.run(id('plan'), 'Pro', 'Growing hotels with multiple revenue centers', 79, 790, JSON.stringify(['Unlimited rooms', 'Full POS (Restaurant & Bar)', 'Accounting module', 'Pool & Hall bookings', 'Priority support']));
  insertPlan.run(id('plan'), 'Enterprise', 'Multi-property groups & resorts', 199, 1990, JSON.stringify(['Everything in Pro', 'Multi-hotel management', 'AI agent add-ons', 'Dedicated account manager']));

  // ── PAYMENT GATEWAYS (platform catalog, superadmin-managed) ─────────────
  const insertGateway = db.prepare(`INSERT INTO payment_gateways (id, name, type, description) VALUES (?,?,?,?)`);
  insertGateway.run(id('gw'), 'Bank Transfer', 'bank_transfer', 'Direct bank-to-bank transfer');
  insertGateway.run(id('gw'), 'POS Terminal', 'pos', 'Card payment via physical POS terminal');
  insertGateway.run(id('gw'), 'Cryptocurrency', 'crypto', 'BTC/USDT and other crypto payments');
  insertGateway.run(id('gw'), 'PayPal', 'paypal', 'International guest payments via PayPal');
  insertGateway.run(id('gw'), 'Payoneer', 'payoneer', 'International guest payments via Payoneer');
  insertGateway.run(id('gw'), 'Airtm', 'airtm', 'Cross-border digital wallet payments');

  // ── PRINTERS ──────────────────────────────────────────────────────────
  const insertPrinter = db.prepare(`INSERT INTO printers (id, tenant_id, name, type, department, connection, is_default) VALUES (?,?,?,?,?,?,?)`);
  insertPrinter.run(id('prn'), t1, 'Restaurant Receipt Printer', 'thermal_80', 'Restaurant', 'network', 1);
  insertPrinter.run(id('prn'), t1, 'Bar Receipt Printer', 'thermal_58', 'Bar', 'usb', 1);
  insertPrinter.run(id('prn'), t1, 'Front Desk Printer', 'a4', 'Front Desk', 'network', 1);

  // ── OTHER SERVICES (shoe, laundry, car) ─────────────────────────────────
  const insertMiscSvc = db.prepare(`INSERT INTO misc_services (id, tenant_id, name, category, price) VALUES (?,?,?,?,?)`);
  insertMiscSvc.run(id('msvc'), t1, 'Shoe Shine', 'Shoe Care', 8);
  insertMiscSvc.run(id('msvc'), t1, 'Laundry — Wash & Fold (per kg)', 'Laundry', 6);
  insertMiscSvc.run(id('msvc'), t1, 'Dry Cleaning — Suit', 'Laundry', 15);
  insertMiscSvc.run(id('msvc'), t1, 'Car Wash', 'Car Service', 20);
  insertMiscSvc.run(id('msvc'), t1, 'Airport Pickup', 'Car Service', 35);

  // Assign Hospitally Grand Resort to the Pro plan
  const proPlan = db.prepare("SELECT id FROM plans WHERE name = 'Pro'").get();
  if (proPlan) db.prepare("UPDATE tenants SET plan_id = ?, billing_cycle = 'monthly', subscription_status = 'active' WHERE id = ?").run(proPlan.id, t1);

  // ── CONVERSATIONS + MESSAGES ─────────────────────────────────────────────
  const insertConv = db.prepare(`INSERT INTO conversations (id, tenant_id, guest_id, guest_name, guest_phone, room_number, online, unread_count, last_message, last_message_at) VALUES (@id,@tenant_id,@guest_id,@guest_name,@guest_phone,@room_number,@online,@unread_count,@last_message,@last_message_at)`);
  const insertMsg = db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body, ai_generated, created_at) VALUES (@id,@tenant_id,@conversation_id,@sender,@body,@ai_generated,@created_at)`);

  function makeConversation(guestName, phone, room, online, unread, msgs) {
    const cid = id('conv');
    insertConv.run({ id:cid, tenant_id:t1, guest_id:guestIds[guestName]||null, guest_name:guestName, guest_phone:phone, room_number:room, online:online?1:0, unread_count:unread, last_message:msgs[msgs.length-1].body, last_message_at:new Date().toISOString() });
    msgs.forEach((m,i) => insertMsg.run({ id:id('msg'), tenant_id:t1, conversation_id:cid, sender:m.sender, body:m.body, ai_generated:m.sender==='ai'?1:0, created_at:new Date(Date.now()-(msgs.length-i)*60000).toISOString() }));
  }

  makeConversation('Mr. Anderson','+1 555 1001','102',true,1,[
    {sender:'guest',body:'Hello, I need an extra pillow please'},
    {sender:'ai',body:"Hello! I'll have housekeeping send an extra pillow to Room 102 right away. Anything else?"},
    {sender:'guest',body:'Can you also get me a glass of water?'},
    {sender:'ai',body:"Of course! I'll have water sent up along with the pillow. Is there anything else I can help with?"},
  ]);
  makeConversation('Ms. Chen','+1 555 1002','106',true,0,[
    {sender:'guest',body:'What time is checkout?'},
    {sender:'ai',body:'Checkout is at 11:00 AM. Late checkout until 2PM is available for $50 — just let me know!'},
    {sender:'guest',body:'Can I extend to 1PM?'},
    {sender:'ai',body:'Absolutely! 1PM checkout has been arranged for you at no extra charge as a courtesy. Enjoy your morning!'},
  ]);
  makeConversation('Johnson Family','+1 555 1003','202',false,2,[
    {sender:'guest',body:'We ordered food 20 mins ago and it has not arrived'},
    {sender:'ai',body:"I'm so sorry for the wait! Let me check with the kitchen immediately and escalate your order."},
    {sender:'staff',body:'Hi! Your order is on the way — about 5 more minutes. Apologies for the delay!'},
  ]);
  makeConversation('Mr. Williams','+1 555 1004','204',false,0,[
    {sender:'guest',body:"I'd like to order Jollof Rice and a Coke"},
    {sender:'ai',body:'Of course! 1x Jollof Rice ($12) + 1x Coke ($3) = $15 total. Payment link: pay.staychat.io/v2984'},
    {sender:'guest',body:'Payment done!'},
    {sender:'ai',body:'Payment verified! Your order is being prepared. Estimated delivery: 15-20 minutes.'},
    {sender:'guest',body:'Thanks, it was delicious!'},
    {sender:'ai',body:'Wonderful! So glad you enjoyed it. Is there anything else I can help with during your stay?'},
  ]);
  makeConversation('Ms. Smith','+1 555 1005','109',true,0,[
    {sender:'guest',body:'Is the pool open?'},
    {sender:'ai',body:'Yes! The pool is open 7AM–10PM daily on the rooftop. Towels are available poolside. Enjoy!'},
  ]);

  // ── TRANSACTIONS ─────────────────────────────────────────────────────────
  const insertTxn = db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref) VALUES (@id,@tenant_id,@guest_name,@room_number,@description,@amount,@method,@status,@gateway_ref)`);
  const txnRows = [
    ['Mr. Williams','204','Jollof Rice + Coke',15,'Paystack','completed'],
    ['Johnson Family','202','Room Service Order',50,'Stripe','completed'],
    ['Mr. Anderson','102','Room Booking (2 nights)',178,'Paystack','completed'],
    ['Ms. Chen','106','Checkout Balance',220,'Stripe','pending'],
    ['Ms. Smith','109','Room Booking',75,'Flutterwave','completed'],
    ['Mr. Williams','204','Room Booking (1 night)',160,'Paystack','completed'],
  ];
  txnRows.forEach(t => insertTxn.run({ id:id('txn'), tenant_id:t1, guest_name:t[0], room_number:t[1], description:t[2], amount:t[3], method:t[4], status:t[5], gateway_ref:'AZ-'+Math.floor(Math.random()*99999) }));

  // ── ANALYTICS DAILY (12 days of history) ────────────────────────────────
  const insertAnalytics = db.prepare(`INSERT OR REPLACE INTO analytics_daily (id, tenant_id, date, revenue, occupancy_pct, orders_count, new_bookings) VALUES (@id,@tenant_id,@date,@revenue,@occupancy_pct,@orders_count,@new_bookings)`);
  const occVals = [75,65,80,70,90,100,85,78,92,68,88,72];
  for (let i = 0; i < 12; i++) {
    const d = new Date(); d.setDate(d.getDate() - (11 - i));
    insertAnalytics.run({ id:id('an'), tenant_id:t1, date:d.toISOString().slice(0,10), revenue: 600 + Math.round(Math.random()*400), occupancy_pct: occVals[i], orders_count: 3+Math.floor(Math.random()*8), new_bookings: Math.floor(Math.random()*4) });
  }

  console.log('✓ Seed complete.');
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════════════╗');
  console.log('  ║                    DEMO ACCOUNTS                                 ║');
  console.log('  ╠═══════════════════════════════════════════════════════════════════╣');
  console.log(`  ║  Password: ${demoPassword}`.padEnd(63) + '║');
  console.log('  ║  Note: Set DEMO_PASSWORD env var to customize'.padEnd(63) + '║');
  console.log('  ╠═══════════════════════════════════════════════════════════════════╣');
  if (!isDesk()) console.log('  ║  superadmin@staychat.io       — Super Admin (all hotels)'.padEnd(63) + '║');
  console.log('  ║  admin@hospitally.com         — Hotel Admin (Hospitally Grand)'.padEnd(63) + '║');
  console.log('  ║  reception@hospitally.com     — Receptionist'.padEnd(63) + '║');
  console.log('  ║  porter@hospitally.com        — Porter (Front Office)'.padEnd(63) + '║');
  console.log('  ║  felix@hospitally.com         — Housekeeping Staff'.padEnd(63) + '║');
  console.log('  ║  cashier@hospitally.com       — Cashier (Restaurant POS)'.padEnd(63) + '║');
  console.log('  ║  barman@hospitally.com        — Barman (Bar POS)'.padEnd(63) + '║');
  console.log('  ║  waiter@hospitally.com        — Waiter (Bar POS)'.padEnd(63) + '║');
  console.log('  ║  server@hospitally.com        — Server (Restaurant POS)'.padEnd(63) + '║');
  console.log('  ║  accountant@hospitally.com    — Accountant'.padEnd(63) + '║');
  console.log('  ║  auditor@hospitally.com      — Auditor (read-only)'.padEnd(63) + '║');
  console.log('  ╚═══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  ⚠️  IMPORTANT: Change demo passwords in production!');
  console.log('');
}

seed();
module.exports = seed;
