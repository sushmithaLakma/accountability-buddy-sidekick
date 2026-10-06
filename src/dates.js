// Calendar helpers. Days are plain 'YYYY-MM-DD' strings so that "today" always
// means the calendar day in the *user's* timezone, wherever they live.

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function isValidDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** The calendar date (YYYY-MM-DD) at instant `now` in timezone `tz`. */
export function todayIn(tz, now = new Date()) {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `day`. */
export function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  return addDays(day, -offset);
}

export function monthStart(day) {
  return `${day.slice(0, 7)}-01`;
}

export function periodStart(horizon, day) {
  return horizon === 'week' ? weekStart(day) : monthStart(day);
}

/** Last day (inclusive) of the period beginning at `start`. */
export function periodEnd(horizon, start) {
  return horizon === 'week' ? addDays(start, 6) : addDays(addMonths(start, 1), -1);
}
