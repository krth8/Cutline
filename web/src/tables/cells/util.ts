import { parseISODate, toISODate } from '../../ui';
import type { Column } from '../types';

// ---- clock (injectable for tests) -------------------------------------------------

let clock: () => Date = () => new Date();

/** Replace the clock used for "Today", "Overdue" etc. Pass null to restore the real one. */
export function setCellClock(fn: (() => Date) | null): void {
  clock = fn ?? (() => new Date());
}

/** Today as 'YYYY-MM-DD' in the viewer's time zone. */
export function today(): string {
  return toISODate(clock());
}

// ---- colours ----------------------------------------------------------------------

export function parseHexColor(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio of two hex colours (1..21); 1 when one cannot be parsed. */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  if (!ca || !cb) return 1;
  const la = luminance(ca);
  const lb = luminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Black or white, whichever reads better on the background; null if the colour is not a hex value. */
export function readableTextColor(background: string): '#000000' | '#ffffff' | null {
  if (!parseHexColor(background)) return null;
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}

// ---- options ----------------------------------------------------------------------

export type Option = NonNullable<Column['options']>[number];

export function findOption(column: Column, value: unknown): Option | undefined {
  return column.options?.find((o) => o.value === value);
}

export function optionLabel(column: Column, value: unknown): string {
  return findOption(column, value)?.label ?? String(value ?? '');
}

/** Match option text typed by a user (label or value, case-insensitive). */
export function matchOption(column: Column, text: string): Option | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  const opts = column.options ?? [];
  return opts.find((o) => o.label.toLowerCase() === t) ?? opts.find((o) => o.value.toLowerCase() === t);
}

export function avatarFor(column: Column, id: string): string | undefined {
  const avatars = column.config?.avatars as Record<string, string> | undefined;
  return avatars?.[id];
}

export const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

// ---- numbers ----------------------------------------------------------------------

/** "1,5" and "1.5" both mean one and a half. Returns null for empty text, undefined for garbage. */
export function parseNumber(text: string): number | null | undefined {
  const t = text.trim().replace(/\s+/g, '');
  if (!t) return null;
  if (!/^[-+]?(\d+[.,]?\d*|[.,]\d+)$/.test(t)) return undefined;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export function formatNumber(n: number, column?: Column): string {
  const decimals = column?.config?.decimals;
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: typeof decimals === 'number' ? decimals : 10,
    ...(typeof decimals === 'number' ? { minimumFractionDigits: decimals } : {}),
  }).format(n);
}

// ---- dates (date-only strings, never converted through a time zone) -----------------

const dayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86400000;
};

/** Whole days from a to b (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round(dayNumber(b) - dayNumber(a));
}

export function addDaysISO(iso: string, n: number): string {
  const d = new Date((dayNumber(iso) + n) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The Monday after `iso` (strictly later). */
export function nextMondayISO(iso: string): string {
  const dow = new Date(dayNumber(iso) * 86400000).getUTCDay(); // 0 = Sunday
  return addDaysISO(iso, (8 - dow) % 7 || 7);
}

export const isISODate = (v: unknown): v is string => typeof v === 'string' && parseISODate(v) !== null;

export function formatShortDate(iso: string, todayISO = today()): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const sameYear = y === Number(todayISO.slice(0, 4));
  // Noon avoids daylight-saving gaps at midnight; formatting in the local zone keeps the day.
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(new Date(y, m - 1, d, 12));
}

export interface DateInfo {
  kind: 'overdue' | 'today' | 'tomorrow' | 'future';
  text: string;
  /** Days from today (negative = past). */
  days: number;
}

export function describeDate(iso: string, todayISO = today()): DateInfo {
  const days = daysBetween(todayISO, iso);
  if (days === 0) return { kind: 'today', text: 'Today', days };
  if (days === 1) return { kind: 'tomorrow', text: 'Tomorrow', days };
  if (days === -1) return { kind: 'overdue', text: 'Yesterday', days };
  return { kind: days < 0 ? 'overdue' : 'future', text: formatShortDate(iso, todayISO), days };
}

/** Accepts ISO, "d.m.yyyy", "d/m/yyyy", "d.m." (this year), today, tomorrow, yesterday. Null = empty, undefined = invalid. */
export function parseDateText(text: string, todayISO = today()): string | null | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  if (t === 'today') return todayISO;
  if (t === 'tomorrow') return addDaysISO(todayISO, 1);
  if (t === 'yesterday') return addDaysISO(todayISO, -1);
  if (parseISODate(t)) return t;
  const m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{4})?)?$/.exec(t);
  if (m) {
    const iso = `${m[3] ?? todayISO.slice(0, 4)}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    if (parseISODate(iso)) return iso;
  }
  return undefined;
}
