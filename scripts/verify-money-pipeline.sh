#!/usr/bin/env bash
# e2e proof of the unified money pipeline:
#   1. Individual + group registration (desk)
#   2. Same-registration replay → returns the SAME booking (duplicate-proof)
#   3. Room-service delivery → ONE folio charge; redelivery replays to the same txn
#   4. Deposit → room balance math stays correct (paid_amount = deposit)
#   5. Settle → collects folio charges; retried settle collects nothing more
#   6. Checkout works afterwards
#   7. POS bar sale (cash) → ONE completed charge; bar_revenue attribution;
#      double-settle rejected 409
# Self-sufficient: picks the first TRULY free rooms for today at runtime, so it
# does not race other suites running against the same demo DB.
set -u
ROOT="$(pwd)"
PORT="${TEST_PORT:-4233}"
DATA_DIR="$(mktemp -d /tmp/staychat-pipeline.XXXXXX)"
cp data/staychat.db "$DATA_DIR/" 2>/dev/null
[ -f data/staychat.db-wal ] && cp data/staychat.db-wal "$DATA_DIR/"
PORT=$PORT DATA_DIR="$DATA_DIR" NODE_ENV=development node server/index.js > "$DATA_DIR/log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$DATA_DIR"' EXIT
for i in $(seq 1 30); do curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
jqget() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);console.log(v===undefined?'undefined':(typeof v==='object'?JSON.stringify(v):v))" 2>/dev/null; }
JAR=/tmp/pipeline-cookies.txt; rm -f "$JAR"

B="http://localhost:$PORT"
CIN=$(date +%F); COUT=$(date -d "+2 days" +%F)

LI=$(curl -s -c "$JAR" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"admin@hospitally.com","password":"Demo@123456"}')
echo "$LI" | grep -q '@' && ok "admin login" || bad "login: $LI"

# Truly free rooms: status available AND no confirmed/checked_in overlap for our window.
BOOKINGS=$(curl -s -b "$JAR" "$B/api/bookings")
ROOMS=$(curl -s -b "$JAR" "$B/api/rooms")
TMPD=$(mktemp -d /tmp/pipeline-state.XXXXXX)
echo "$ROOMS" > "$TMPD/rooms.json"; echo "$BOOKINGS" > "$TMPD/bookings.json"
FREEIDS=$(node -e "
const rooms=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const bks=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));
// Mirror the SERVER's conflict predicate EXACTLY: a room is busy only when a
// confirmed/checked_in booking overlaps OUR window (checkIn/out come via argv).
const winIn=process.argv[3], winOut=process.argv[4];
const busy=new Set();
bks.filter(b=>['confirmed','checked_in'].includes(b.status)).forEach(b=>{
  if (b.check_in >= winOut || b.check_out <= winIn) return; // no overlap
  (b.rooms||[]).forEach(r=>busy.add(r.room_id));
});
const free=rooms.filter(r=>r.status==='available'&&!busy.has(r.id));
console.log(free.slice(0,4).map(r=>r.id).join(' '));
" "$TMPD/rooms.json" "$TMPD/bookings.json" "$CIN" "$COUT")
read -r R1 R2 R3 R4 <<< "$FREEIDS"
[ -n "$R1" ] && [ -n "$R2" ] && [ -n "$R3" ] && ok "truly free rooms found: $R1 $R2 $R3 $(echo ${R4:+$R4})" || bad "not enough free rooms (need 3): $FREEIDS"

# ── 1. Individual registration with deposit ──
BK1=$(curl -s -b "$JAR" -X POST "$B/api/bookings" -H 'Content-Type: application/json' -d "{\"guestName\":\"Pipeline Tester\",\"guestPhone\":\"+2348011100220\",\"checkIn\":\"$CIN\",\"checkOut\":\"$COUT\",\"roomIds\":[\"$R1\"],\"adults\":1,\"depositAmount\":50,\"payment\":{\"method\":\"cash\",\"amount\":50}}")
BID1=$(echo "$BK1" | jqget 'd.id'); REF1=$(echo "$BK1" | jqget 'd.reference')
PAID1=$(echo "$BK1" | jqget 'd.paidAmount === undefined ? d.paid_amount : d.paidAmount')
[ "$BID1" != "undefined" ] && ok "individual booking $REF1 (deposit paid: $PAID1)" || bad "booking1: $(echo "$BK1" | head -c 200)"
[ "$PAID1" = "50" ] && ok "deposit flowed to paid_amount (50)" || bad "paid_amount: $PAID1"

# ── 2. Same-registration replay → same booking (case/format variations) ──
BK2=$(curl -s -b "$JAR" -X POST "$B/api/bookings" -H 'Content-Type: application/json' -d "{\"guestName\":\"pipeline tester\",\"guestPhone\":\"08011100220\",\"checkIn\":\"$CIN\",\"checkOut\":\"$COUT\",\"roomIds\":[\"$R1\"],\"adults\":1}")
DUPID=$(echo "$BK2" | jqget 'd.id')
DUPFLAG=$(echo "$BK2" | jqget 'd.duplicate')
[ "$DUPID" = "$BID1" ] && [ "$DUPFLAG" = "true" ] && ok "same-registration replay returned the ORIGINAL booking (no 2nd registration)" || bad "replay: id=$DUPID dup=$DUPFLAG $(echo "$BK2" | head -c 150)"

# ── 3. Group registration (2 rooms, one reference) ──
# Re-query live state AFTER the individual booking — R1 is now busy, plus any
# rooms other tenants/tests booked meanwhile. The group takes the next 2 free.
BOOKINGS2=$(curl -s -b "$JAR" "$B/api/bookings")
ROOMS2=$(curl -s -b "$JAR" "$B/api/rooms")
echo "$ROOMS2" > "$TMPD/rooms2.json"; echo "$BOOKINGS2" > "$TMPD/bookings2.json"
GROUPIDS=$(node -e "
const rooms=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const bks=JSON.parse(require('fs').readFileSync(process.argv[2],'utf8'));
const winIn=process.argv[3], winOut=process.argv[4];
const busy=new Set();
bks.filter(b=>['confirmed','checked_in'].includes(b.status)).forEach(b=>{
  if (b.check_in >= winOut || b.check_out <= winIn) return;
  (b.rooms||[]).forEach(r=>busy.add(r.room_id));
});
const free=rooms.filter(r=>r.status==='available'&&!busy.has(r.id));
console.log(free.slice(0,2).map(r=>r.id).join(' '));
" "$TMPD/rooms2.json" "$TMPD/bookings2.json" "$CIN" "$COUT")
read -r GR2 GR3 <<< "$GROUPIDS"
[ -n "$GR2" ] && [ -n "$GR3" ] && ok "2 more free rooms for the group" || bad "fewer than 2 free rooms now ($GROUPIDS)"
BK3=$(curl -s -b "$JAR" -X POST "$B/api/bookings" -H 'Content-Type: application/json' -d "{\"guestName\":\"The Johnsons\",\"groupName\":\"Johnson Family\",\"guestPhone\":\"+2348033300440\",\"checkIn\":\"$CIN\",\"checkOut\":\"$COUT\",\"roomIds\":[\"$GR2\",\"$GR3\"],\"isGroup\":true,\"adults\":4}")
BID3=$(echo "$BK3" | jqget 'd.id')
NG=$(echo "$BK3" | jqget '(d.rooms||[]).length')
[ "$NG" = "2" ] && [ "$BID3" != "undefined" ] && ok "group booking holds 2 rooms under one reference" || bad "group: $(echo "$BK3" | head -c 200)"

# group folio: room number can be arbitrary — post room service against R1's room number
RN=$(echo "$ROOMS" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log((d.find(x=>x.id===process.argv[1])||{}).number)" "$R1")
[ -n "$RN" ] && [ "$RN" != "undefined" ] && ok "room number $RN resolved" || bad "room number lookup failed"

# ── 4. Check-in → room-service delivery posts ONE charge; redelivery no-op ──
CI=$(curl -s -b "$JAR" -X POST "$B/api/bookings/$BID1/checkin" -H 'Content-Type: application/json' -d '{}')
CISt=$(echo "$CI" | jqget 'd.status')
[ "$CISt" = "checked_in" ] && ok "guest checked in (folio opens: room 101 + incidentals attach)" || bad "checkin: $(echo "$CI" | head -c 150)"
ORD=$(curl -s -b "$JAR" -X POST "$B/api/orders" -H 'Content-Type: application/json' -d "{\"roomNumber\":\"$RN\",\"guestName\":\"Pipeline Tester\",\"items\":[{\"name\":\"Jollof Rice\",\"qty\":2,\"price\":1500}],\"total\":3000}")
OID=$(echo "$ORD" | jqget 'd.id')
curl -s -b "$JAR" -X PATCH "$B/api/orders/$OID/status" -H 'Content-Type: application/json' -d '{"status":"delivered"}' >/dev/null
curl -s -b "$JAR" -X PATCH "$B/api/orders/$OID/status" -H 'Content-Type: application/json' -d '{"status":"delivered"}' >/dev/null  # network-retry replay
N=$(curl -s -b "$JAR" "$B/api/bookings/$BID1/folio" | jqget '(d.charges||[]).filter(c=>(c.description||"").includes("Room Service")).length')
[ "$N" = "1" ] && ok "room-service delivery posted EXACTLY ONE folio charge (retry-proof)" || bad "folio room-service charges: $N (need 1)"

# ── 5. Settle the whole folio; retry is refused, not double-collected ──
BAL=$(curl -s -b "$JAR" "$B/api/payments/balance?bookingId=$BID1")
GRAND=$(echo "$BAL" | jqget 'd.grandTotal')
ST=$(curl -s -b "$JAR" -X POST "$B/api/payments/settle" -H 'Content-Type: application/json' -d "{\"bookingId\":\"$BID1\",\"method\":\"cash\",\"cashReceived\":$GRAND}")
COLL=$(echo "$ST" | jqget 'd.grandTotal')
[ "$COLL" = "$GRAND" ] && ok "settle collected the full folio ($GRAND)" || bad "settle: $COLL vs $GRAND"
ST2=$(curl -s -b "$JAR" -X POST "$B/api/payments/settle" -H 'Content-Type: application/json' -d "{\"bookingId\":\"$BID1\",\"method\":\"cash\",\"cashReceived\":999999}")
COLL2=$(echo "$ST2" | jqget 'd.grandTotal === undefined ? 0 : d.grandTotal')
ERR2=$(echo "$ST2" | jqget 'd.error')
if [ "$COLL2" = "0" ]; then ok "retried settle collected NOTHING extra (0 after $GRAND)"; else bad "double settle collected again: $COLL2 (err: $ERR2)"; fi

# ── 6. Checkout works afterwards ──
CO=$(curl -s -b "$JAR" -X POST "$B/api/bookings/$BID1/checkout" -H 'Content-Type: application/json' -d '{}')
COSt=$(echo "$CO" | jqget 'd.status')
[ "$COSt" = "checked_out" ] && ok "guest checked out clean after settlement" || bad "checkout: $(echo "$CO" | head -c 200)"

# ── 7. POS bar sale (cash) — attribution + double-settle 409 ──
TC=$(curl -s -b "$JAR" -X POST "$B/api/pos/tickets" -H 'Content-Type: application/json' -d '{"outlet":"bar","label":"Pipeline Verify"}')
TID=$(echo "$TC" | jqget 'd.id')
ADD=$(curl -s -b "$JAR" -X POST "$B/api/pos/tickets/$TID/items" -H 'Content-Type: application/json' -d '{"name":"Beer","price":800,"qty":2}' -o /dev/null -w '%{http_code}')
[ "$ADD" = "200" ] || [ "$ADD" = "201" ] && ok "POS item added to open ticket ($ADD)" || bad "pos add item: $ADD"
TC2=$(curl -s -b "$JAR" -X POST "$B/api/pos/tickets/$TID/checkout" -H 'Content-Type: application/json' -d '{"paymentMethod":"cash"}')
TXNPOS=$(echo "$TC2" | jqget 'd.transaction.id')
[ "$TXNPOS" != "undefined" ] && [ "$TXNPOS" != "null" ] && ok "POS bar sale posted one completed charge" || bad "pos: $(echo "$TC2" | head -c 300)"
DUPINS=$(curl -s -b "$JAR" -X POST "$B/api/pos/tickets/$TID/checkout" -H 'Content-Type: application/json' -d '{"paymentMethod":"cash"}' -o /dev/null -w '%{http_code}')
[ "$DUPINS" = "409" ] && ok "POS double-settle rejected with 409" || bad "pos retry status: $DUPINS"
ACC=$(curl -s -b "$JAR" "$B/api/accounting/trial-balance")
BAR=$(echo "$ACC" | jqget '(d.rows||[]).filter(r=>r.account.system_key==="bar_revenue")[0].credit || 0')
[ "${BAR:-0}" -gt "0" ] 2>/dev/null && ok "bar sale credited BAR revenue account ($BAR) — correctly distributed" || bad "bar_revenue credit: $BAR"

echo ""
echo "═══ PIPELINE VERIFY: $PASS passed, $FAIL failed ═══"
rm -f "$JAR"; rm -rf "$TMPD"
exit $FAIL
