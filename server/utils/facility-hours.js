// server/utils/facility-hours.js
// Daily operating windows for sellable facilities (gym, pool, hall).
//
// Every facility row carries open_time / close_time as "HH:MM" (24h). A slot is
// only sellable when it sits entirely inside that window — the desk and the
// public booking channel both validate with these helpers, so a hotel can never
// take a 02:00 ballroom booking just because the client sent one.
'use strict';

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a real 24h "HH:MM" value. */
function validTime(value) {
  return TIME_RE.test(String(value || '').trim());
}

/** Normalise to "HH:MM" (accepts "9:00", trims spaces); null when invalid. */
function normalizeTime(value) {
  const raw = String(value == null ? '' : value).trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/** A window is valid when both ends are times and it has positive length. */
function validWindow(open, close) {
  const o = normalizeTime(open), c = normalizeTime(close);
  return !!o && !!c && o < c;
}

/** Hours object for a facility row, with safe defaults. */
function hoursOf(row, defaults) {
  const d = defaults || {};
  const open = normalizeTime(row && row.open_time) || d.open || '00:00';
  const close = normalizeTime(row && row.close_time) || d.close || '23:59';
  return { open, close };
}

/**
 * Is the [start, end] slot inside the facility's window?
 * Returns { ok, reason }. String comparison is safe for zero-padded HH:MM.
 */
function slotWithinHours(row, start, end, defaults) {
  const { open, close } = hoursOf(row, defaults);
  const s = normalizeTime(start), e = normalizeTime(end);
  if (!s || !e) return { ok: false, reason: 'Enter a valid start and end time' };
  if (e <= s) return { ok: false, reason: 'End time must be after start time' };
  if (s < open || e > close) {
    return { ok: false, reason: 'Open ' + open + '–' + close + ' only — pick a slot inside those hours' };
  }
  return { ok: true, open, close };
}

module.exports = { validTime, normalizeTime, validWindow, hoursOf, slotWithinHours };
