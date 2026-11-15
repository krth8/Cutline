import { formatShortDate } from '../tables/cells/util';

/** A date in this year is shown without the year by `formatShortDate`; passing a far-away "today" always adds it. */
const ANY_OTHER_YEAR = '1900-01-01';

/** The date part of a server timestamp ("2026-11-15T10:20:30.5") or date ("2026-11-15"), else null. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "15 Nov 2026" style date with the year always shown (same formatter as the date cell). */
export function formatDay(value: unknown): string {
  const day = dayOf(value);
  return day ? formatShortDate(day, ANY_OTHER_YEAR) : '';
}

/**
 * "just now", "5m ago", "3h ago", "2d ago", then the date cell's short date ("15 Nov", with the year when it
 * is not this year).
 */
export function relativeTime(value: string, now: Date = new Date()): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  const day = dayOf(value);
  return day ? formatShortDate(day, `${now.getFullYear()}-01-01`) : '';
}
