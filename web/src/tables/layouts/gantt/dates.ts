// Date-only helpers for the Gantt layout. Dates are plain 'YYYY-MM-DD' strings. Nothing here goes through
// the Date constructor's string parsing (which reads dates as UTC) or toISOString(), so the results do not
// depend on the time zone of the browser. A "day index" is the number of days since 1970-01-01.

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number; // 1-31
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
}

/** Strict parse: exactly YYYY-MM-DD and a real calendar day; anything else is null. */
export function parseYmd(value: unknown): Ymd | null {
  if (typeof value !== 'string') return null;
  const match = DATE_RE.exec(value);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

export function formatYmd({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Days since 1970-01-01 for a calendar day (proleptic Gregorian, civil-from-days algorithm). */
export function ymdToDayIndex({ y, m, d }: Ymd): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function dayIndexToYmd(n: number): Ymd {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Day index of a 'YYYY-MM-DD' string, or null when it is not a valid date. */
export function toDayIndex(value: unknown): number | null {
  const ymd = parseYmd(value);
  return ymd ? ymdToDayIndex(ymd) : null;
}

export function fromDayIndex(n: number): string {
  return formatYmd(dayIndexToYmd(n));
}

export function addDays(value: string, days: number): string | null {
  const idx = toDayIndex(value);
  return idx === null ? null : fromDayIndex(idx + days);
}

/** Whole days from a to b (positive when b is later). */
export function diffDays(a: string, b: string): number | null {
  const x = toDayIndex(a);
  const y = toDayIndex(b);
  return x === null || y === null ? null : y - x;
}

/** 0 = Sunday ... 6 = Saturday (1970-01-01 was a Thursday). */
export function weekdayOfIndex(n: number): number {
  return (((n + 4) % 7) + 7) % 7;
}

export function isWeekendIndex(n: number): boolean {
  const w = weekdayOfIndex(n);
  return w === 0 || w === 6;
}

/** Day index of the first day of the month that contains the given day, shifted by `months` months. */
export function monthStartIndex(n: number, months = 0): number {
  const { y, m } = dayIndexToYmd(n);
  const total = y * 12 + (m - 1) + months;
  return ymdToDayIndex({ y: Math.floor(total / 12), m: (((total % 12) + 12) % 12) + 1, d: 1 });
}

/** Day index of the first day of the year that contains the given day. */
export function yearStartIndex(n: number, years = 0): number {
  return ymdToDayIndex({ y: dayIndexToYmd(n).y + years, m: 1, d: 1 });
}

/** Day index of the Monday on or before the given day. */
export function mondayOnOrBefore(n: number): number {
  return n - ((weekdayOfIndex(n) + 6) % 7);
}

/** Today in the browser's local calendar, as 'YYYY-MM-DD'. */
export function todayString(now: Date = new Date()): string {
  return formatYmd({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}
