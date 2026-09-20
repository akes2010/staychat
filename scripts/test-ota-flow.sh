#!/usr/bin/env bash
# End-to-end exercise of the self-OTA booking engine channel.
# Boots a throwaway server instance against a COPY of the DB, runs the full
# guest → desk loop via the public API, then shuts down. No production data touched.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${TEST_PORT:-4199}"
DATA_DIR="$(mktemp -d /tmp/staychat-ota-test.XXXXXX)"
LOG="$DATA_DIR/server.log"

cp "$ROOT/data/staychat.db" "$DATA_DIR/staychat.db"
[ -f "$ROOT/data/staychat.db-wal" ] && cp "$ROOT/data/staychat.db-wal" "$DATA_DIR/"
[ -f "$ROOT/data/staychat.db-shm" ] && cp "$ROOT/data/staychat.db-shm" "$DATA_DIR/"

PORT=$PORT DATA_DIR="$DATA_DIR" NODE_ENV=development node "$ROOT/server/index.js" > "$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$DATA_DIR"' EXIT

for i in $(seq 1 30); do
  curl -s "http://localhost:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done

B="http://localhost:$PORT/api/booking-engine"
SUB="hospitally"
CIN=$(date +%F); COUT=$(date -d "+3 days" +%F)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }
jqget() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=($1);console.log(v===undefined?'undefined':(typeof v==='object'?JSON.stringify(v):v))" 2>/dev/null; }

echo "── Guest: open booking link"
CFG=$(curl -s "$B/config?subdomain=$SUB")
NAME=$(echo "$CFG" | jqget 'd.hotelName')
CUR=$(echo "$CFG" | jqget 'd.currency')
[ "$NAME" != "undefined" ] && [ -n "$NAME" ] && ok "config loads — hotel '$NAME', currency $CUR" || bad "config failed: $CFG"

echo "── Guest: search availability"
AV=$(curl -s "$B/availability?subdomain=$SUB&checkIn=$CIN&checkOut=$COUT")
COUNT=$(echo "$AV" | jqget '(d.rooms||[]).length')
if [ "$COUNT" = "0" ]; then
  bad "availability returned 0 rooms for $CIN→$COUT — guests cannot book at all. Raw: $(echo "$AV" | head -c 300)"
  kill $SRV 2>/dev/null; exit 1
fi
ok "availability returns $COUNT rooms"
FIRST=$(echo "$AV" | jqget 'd.rooms[0].roomId')
FIRST_TOTAL=$(echo "$AV" | jqget 'd.rooms[0].total')
FIRST_RATE=$(echo "$AV" | jqget 'd.rooms[0].rate')
FIRST_NIGHTS=$(echo "$AV" | jqget 'd.rooms[0].nights')
echo "    room $FIRST · $FIRST_NIGHTS nights · $FIRST_RATE/night · total $FIRST_TOTAL"

echo "── Guest: submit booking"
BK=$(curl -s -X POST "$B/book" -H 'Content-Type: application/json' \
  -d "{\"subdomain\":\"$SUB\",\"guestName\":\"OTA Flow Tester\",\"guestPhone\":\"+2348012345678\",\"guestEmail\":\"ota-test@example.com\",\"checkIn\":\"$CIN\",\"checkOut\":\"$COUT\",\"roomIds\":[\"$FIRST\"],\"adults\":1,\"children\":0}")
CODE=$(echo "$BK" | jqget 'd.code')
REF=$(echo "$BK" | jqget 'd.reference')
TOTAL=$(echo "$BK" | jqget 'd.total')
if [ "$CODE" != "undefined" ] && [ -n "$CODE" ] && [ "$CODE" != "null" ]; then
  ok "booking created — ref $REF, code $CODE, total $TOTAL"
else
  bad "booking failed: $(echo "$BK" | head -c 300)"; kill $SRV 2>/dev/null; exit 1
fi
[ "$TOTAL" = "$FIRST_TOTAL" ] && ok "guest quote matches availability quote ($TOTAL)" || bad "quote mismatch: avail $FIRST_TOTAL vs book $TOTAL"

echo "── Guest: confirmation lookup by code"
CF=$(curl -s "$B/confirmation?subdomain=$SUB&code=$CODE")
CFST=$(echo "$CF" | jqget 'd.status')
[ "$CFST" = "pending_payment" ] && ok "confirmation slip shows AWAITING DESK CONFIRMATION" || bad "confirmation status: $CFST ($(echo "$CF" | head -c 200))"

echo "── Desk: log in as receptionist"
JAR="$(mktemp)"
LI=$(curl -s -c "$JAR" -X POST "http://localhost:$PORT/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"reception@hospitally.com","password":"Demo@123456"}')
UID_=$(echo "$LI" | jqget 'd.user.id')
[ "$UID_" != "undefined" ] && ok "receptionist authenticated" || bad "login failed: $(echo "$LI" | head -c 200)"

echo "── Desk: find the pending submission"
BL=$(curl -s -b "$JAR" "http://localhost:$PORT/api/bookings")
BID=$(echo "$BL" | jqget "(d.find(x=>x.engineCode==='$CODE')||{}).id")
[ "$BID" != "undefined" ] && [ -n "$BID" ] && ok "pending submission visible in Bookings (tab: Pending)" || { bad "desk cannot see booking by code $CODE: $(echo "$BL" | head -c 300)"; kill $SRV; exit 1; }

echo "── Desk: confirm with the tender code"
CN=$(curl -s -b "$JAR" -X POST "http://localhost:$PORT/api/bookings/$BID/confirm")
CNST=$(echo "$CN" | jqget 'd.status')
[ "$CNST" = "confirmed" ] && ok "booking confirmed — room held, guest notified" || bad "confirm failed: $(echo "$CN" | head -c 300)"

echo "── Desk: check the guest in"
CI=$(curl -s -b "$JAR" -X POST "http://localhost:$PORT/api/bookings/$BID/checkin")
CIST=$(echo "$CI" | jqget 'd.status')
[ "$CIST" = "checked_in" ] && ok "checked in — rooms occupied" || bad "checkin failed: $(echo "$CI" | head -c 300)"

echo "── Desk: collect payment at the desk (admin has payments.manage)"
LI2=$(curl -s -c "$JAR" -X POST "http://localhost:$PORT/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@hospitally.com","password":"Demo@123456"}')
CUID=$(echo "$LI2" | jqget 'd.user.id')
[ "$CUID" != "undefined" ] && ok "admin authenticated" || bad "admin login failed: $(echo "$LI2" | head -c 200)"
PM=$(curl -s -b "$JAR" -c "$JAR" -X POST "http://localhost:$PORT/api/payments/settle" -H 'Content-Type: application/json' \
  -d "{\"bookingId\":\"$BID\",\"method\":\"cash\",\"cashReceived\":$TOTAL}")
COLL=$(echo "$PM" | jqget 'd.grandTotal')
if [ "$COLL" != "undefined" ] && [ "$COLL" != "null" ] && [ -n "$COLL" ]; then
  ok "payment settled — collected $COLL of $TOTAL"
else
  bad "settle failed: $(echo "$PM" | head -c 400)"
fi


echo "── Guest: confirmation now shows CHECKED IN"
CF2=$(curl -s "$B/confirmation?subdomain=$SUB&code=$CODE")
CF2S=$(echo "$CF2" | jqget 'd.status')
CF2P=$(echo "$CF2" | jqget 'd.paid')
[ "$CF2S" = "checked_in" ] && ok "guest slip reflects checked-in + paid $CF2P" || bad "post-checkin slip: $CF2S paid=$CF2P"

echo "── Receipt data check (booking folio)"
FO=$(curl -s -b "$JAR" "http://localhost:$PORT/api/bookings/$BID/folio")
FOG=$(echo "$FO" | jqget 'd.grandTotal')
[ "$FOG" != "undefined" ] && ok "folio/receipt totals available (grand $FOG)" || bad "folio failed: $(echo "$FO" | head -c 300)"

# ── FACILITIES (halls + pool) through the same public channel ────────────────
echo "── Guest: list facilities"
FC=$(curl -s "$B/facilities?subdomain=$SUB")
HALLS=$(echo "$FC" | jqget '(d.halls||[]).length')
POOLS=$(echo "$FC" | jqget '(d.pools||[]).length')
if [ "$HALLS" != "0" ] && [ "$HALLS" != "undefined" ]; then ok "facilities: $HALLS halls, $POOLS pools"; else
  bad "no halls returned: $(echo "$FC" | head -c 200)"; fi
HALL=$(echo "$FC" | jqget 'd.halls[0].id')
POOL=$(echo "$FC" | jqget '(d.pools.find(p=>p.capacity>=2)||d.pools[0]||{}).id')

echo "── Guest: check hall slot availability"
FA=$(curl -s "$B/facility-availability?subdomain=$SUB&kind=hall&facilityId=$HALL&date=$(date -d '+5 days' +%F)&startTime=10:00&endTime=14:00&partySize=10")
FAA=$(echo "$FA" | jqget 'd.available')
[ "$FAA" = "true" ] && ok "hall slot free" || bad "hall availability: $FA"

echo "── Guest: book the hall"
FB=$(curl -s -X POST "$B/facility-book" -H 'Content-Type: application/json' \
  -d "{\"subdomain\":\"$SUB\",\"kind\":\"hall\",\"facilityId\":\"$HALL\",\"guestName\":\"Facility Tester\",\"guestPhone\":\"+2348099887766\",\"guestEmail\":\"fac-test@example.com\",\"date\":\"$(date -d '+5 days' +%F)\",\"startTime\":\"10:00\",\"endTime\":\"14:00\",\"partySize\":10,\"eventName\":\"E2E Wedding\"}")
FCODE=$(echo "$FB" | jqget 'd.code')
FTOTAL=$(echo "$FB" | jqget 'd.total')
if [ "$FCODE" != "undefined" ] && [ -n "$FCODE" ] && [ "$FCODE" != "null" ]; then ok "hall booked — code $FCODE, total $FTOTAL"; else bad "hall book failed: $(echo "$FB" | head -c 300)"; fi

echo "── Guest: facility confirmation slip by code"
FCF=$(curl -s "$B/confirmation?subdomain=$SUB&code=$FCODE")
FCFN=$(echo "$FCF" | jqget 'd.facility.name')
FCFS=$(echo "$FCF" | jqget 'd.status')
[ "$FCFS" = "pending_payment" ] && ok "slip shows hall '$FCFN' AWAITING DESK CONFIRMATION" || bad "facility slip: $FCFS ($(echo "$FCF" | head -c 200))"

echo "── Desk: pending facility submission appears"
FP=$(curl -s -b "$JAR" "http://localhost:$PORT/api/bookings/facilities/pending")
FPN=$(echo "$FP" | jqget "(d.filter(x=>x.engineCode==='$FCODE')).length")
[ "$FPN" = "1" ] && ok "facility submission visible on desk Pending" || bad "pending facilities: $(echo "$FP" | head -c 300)"

echo "── Desk: confirm facility by tender code"
FCN=$(curl -s -b "$JAR" -X POST "http://localhost:$PORT/api/bookings/facilities/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$FCODE\"}")
FCNS=$(echo "$FCN" | jqget 'd.booking.status')
[ "$FCNS" = "confirmed" ] && ok "hall reservation confirmed" || bad "facility confirm: $(echo "$FCN" | head -c 300)"

echo "── Guest: pool slot booking + confirm"
if [ "$POOL" != "undefined" ] && [ -n "$POOL" ] && [ "$POOL" != "null" ]; then
  PB=$(curl -s -X POST "$B/facility-book" -H 'Content-Type: application/json' \
    -d "{\"subdomain\":\"$SUB\",\"kind\":\"pool\",\"facilityId\":\"$POOL\",\"guestName\":\"Facility Tester\",\"guestPhone\":\"+2348099887766\",\"date\":\"$(date +%F)\",\"startTime\":\"16:00\",\"endTime\":\"17:00\",\"partySize\":2}")
  PCODE=$(echo "$PB" | jqget 'd.code')
  if [ "$PCODE" != "undefined" ] && [ -n "$PCODE" ] && [ "$PCODE" != "null" ]; then
    ok "pool slot booked — code $PCODE"
    PC=$(curl -s -b "$JAR" -X POST "http://localhost:$PORT/api/bookings/facilities/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$PCODE\"}")
    PCS=$(echo "$PC" | jqget 'd.booking.engine_sync_status')
    [ "$PCS" = "confirmed" ] && ok "pool reservation confirmed" || bad "pool confirm: $(echo "$PC" | head -c 300)"
  else
    bad "pool book failed: $(echo "$PB" | head -c 300)"
  fi
else
  bad "no sellable pool returned"
fi

echo "── Guest: double-confirm rejected (code already processed)"
FC2=$(curl -s -b "$JAR" -X POST "http://localhost:$PORT/api/bookings/facilities/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$FCODE\"}")
FC2E=$(echo "$FC2" | jqget 'd.error')
[ "$FC2E" != "null" ] && [ "$FC2E" != "undefined" ] && ok "second confirm correctly rejected ($FC2E)" || bad "double-confirm should fail: $FC2"

echo ""
echo "═══ RESULT: $PASS passed, $FAIL failed ═══"
rm -f "$JAR"
[ $FAIL -eq 0 ]
