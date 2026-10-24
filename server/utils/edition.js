// server/utils/edition.js
// Which product edition this process serves.
//
//   hosted (default) — the SaaS/VPS build: a platform `superadmin` operates all
//                      hotels (plans, gateways, subscription approvals, the
//                      Super Admin console).
//   desk             — StayChat Desk, the desktop app. electron/boot-server.js
//                      sets STAYCHAT_EDITION=desk before any server module is
//                      loaded: the edition has NO superadmin at all — no
//                      seeded platform login, no console — and the hotel's own
//                      `hotel_admin` runs the platform features (plans,
//                      billing approvals) scoped to their own hotel instead.
//
// Tests and `npm start` boot server/index.js directly, so they always see the
// hosted edition unless STAYCHAT_EDITION is set explicitly.
'use strict';

function isDesk() {
  return process.env.STAYCHAT_EDITION === 'desk';
}

module.exports = { isDesk };