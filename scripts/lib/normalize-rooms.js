// scripts/lib/normalize-rooms.js
// Shared test precondition: bookable inventory in a THROWAWAY DB copy.
//
// Several suites copy data/staychat.db into a temp dir and then drive the
// booking flow (create booking → check in → settle). The dev DB accumulates
// dirty/occupied/maintenance room statuses from manual runs — with no live
// bookings behind them — which starves booking-engine availability to 0 rooms
// and fails those suites before they test anything ("could not create a
// checked-in booking with a balance", "availability returned 0 rooms").
// This normalizes the COPY only; the real dev DB is never touched. Rooms with
// a live (confirmed / checked-in) booking are left alone.
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function normalizeRoomsInCopy(dataDir) {
  const dbPath = path.join(dataDir, 'staychat.db');
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath);
  try {
    const res = db.prepare(`
      UPDATE rooms SET status='available', guest_name=NULL, checkout_label=NULL, issue=NULL
      WHERE status IN ('dirty','maintenance','occupied')
        AND id NOT IN (SELECT room_id FROM bookings
                       WHERE room_id IS NOT NULL AND status IN ('confirmed','checked_in'))
    `).run();
    return res.changes;
  } finally {
    db.close();
  }
}

module.exports = { normalizeRoomsInCopy };
