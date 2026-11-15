/**
 * Date-only helpers. A day is a plain 'YYYY-MM-DD' string; all arithmetic is done on year/month/day
 * numbers (a day count from a fixed epoch), never through a `Date` built from the string, so no time
 * zone or daylight saving change can move a day.
 */

export type Ymd = string;

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

export interface Civil {
  y: number;
  m: number; // 1..12
  d: number; // 1..31
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Parses the leading 'YYYY-MM-DD' of a value (a longer timestamp is cut to its date part); null when it is no real day. */
export function parseYmd(value: unknown): Civil | null {
  if (typeof value !== 'string') return null;
  const match = PATTERN.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** The normalised 'YYYY-MM-DD' of a value, or null. */
export function normalizeYmd(value: unknown): Ymd | null {
  const c = parseYmd(value);
  return c ? formatYmd(c.y, c.m, c.d) : null;
}

export function formatYmd(y: number, m: number, d: number): Ymd {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days since 1970-01-01 of a civil date (proleptic Gregorian). */
function toDayNumber({ y, m, d }: Civil): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(n: number): Civil {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}

function must(day: Ymd): Civil {
  const c = parseYmd(day);
  if (!c) throw new Error(`Not a date: ${String(day)}`);
  return c;
}

export function addDays(day: Ymd, n: number): Ymd {
  const c = fromDayNumber(toDayNumber(must(day)) + n);
  return formatYmd(c.y, c.m, c.d);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: Ymd, b: Ymd): number {
  return toDayNumber(must(b)) - toDayNumber(must(a));
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(day: Ymd): number {
  // 1970-01-01 was a Thursday (index 3)
  return (((toDayNumber(must(day)) + 3) % 7) + 7) % 7;
}

export function startOfWeek(day: Ymd): Ymd {
  return addDays(day, -weekdayIndex(day));
}

export function startOfMonth(day: Ymd): Ymd {
  const c = must(day);
  return formatYmd(c.y, c.m, 1);
}

/** The same day number in another month, clamped to the month's length. */
export function addMonths(day: Ymd, n: number): Ymd {
  const c = must(day);
  const index = c.y * 12 + (c.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (((index % 12) + 12) % 12) + 1;
  return formatYmd(y, m, Math.min(c.d, daysInMonth(y, m)));
}

/** Seven days from `start`. */
export function weekOf(start: Ymd): Ymd[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** The weeks (Monday first) that cover the month of `day`: 4 to 6 rows of 7 days. */
export function monthGrid(day: Ymd): Ymd[][] {
  const c = must(day);
  const first = formatYmd(c.y, c.m, 1);
  const last = formatYmd(c.y, c.m, daysInMonth(c.y, c.m));
  const weeks: Ymd[][] = [];
  for (let s = startOfWeek(first); diffDays(s, last) >= 0; s = addDays(s, 7)) weeks.push(weekOf(s));
  return weeks;
}

export function sameMonth(a: Ymd, b: Ymd): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

/** The viewer's local calendar day (read from the clock's local fields, not from an ISO string). */
export function todayYmd(now: Date = new Date()): Ymd {
  return formatYmd(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function monthTitle(day: Ymd): string {
  const c = must(day);
  return `${MONTH_NAMES[c.m - 1]} ${c.y}`;
}

/** "9 - 15 Nov 2026", "28 Nov - 4 Dec 2026" or "29 Dec 2026 - 4 Jan 2027". */
export function weekTitle(start: Ymd): string {
  const a = must(start);
  const b = must(addDays(start, 6));
  const short = (c: Civil) => MONTH_NAMES[c.m - 1]!.slice(0, 3);
  if (a.y !== b.y) return `${a.d} ${short(a)} ${a.y} - ${b.d} ${short(b)} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${short(a)} - ${b.d} ${short(b)} ${b.y}`;
  return `${a.d} - ${b.d} ${short(b)} ${b.y}`;
}

export function dayOfMonth(day: Ymd): number {
  return must(day).d;
}
