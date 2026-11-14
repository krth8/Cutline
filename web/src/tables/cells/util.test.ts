import { afterEach, describe, expect, it } from 'vitest';
import {
  addDaysISO,
  contrastRatio,
  daysBetween,
  describeDate,
  formatShortDate,
  nextMondayISO,
  parseDateText,
  parseNumber,
  readableTextColor,
  setCellClock,
  today,
} from './util';

declare const process: { env: Record<string, string | undefined> };

afterEach(() => setCellClock(null));

describe('option colour contrast', () => {
  it('picks white on dark and black on light colours', () => {
    expect(readableTextColor('#1e3a8a')).toBe('#ffffff');
    expect(readableTextColor('#000')).toBe('#ffffff');
    expect(readableTextColor('#fde047')).toBe('#000000');
    expect(readableTextColor('#ffffff')).toBe('#000000');
  });

  it('always reaches the WCAG AA ratio for body text on the palette colours', () => {
    for (const c of ['#6b7280', '#f59e0b', '#ef4444', '#8b5cf6', '#3b82f6', '#10b981', '#ec4899', '#6366f1', '#22c55e', '#777777']) {
      const text = readableTextColor(c)!;
      expect(contrastRatio(c, text), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('returns null for colours that are not hex (css variables)', () => {
    expect(readableTextColor('var(--accent)')).toBeNull();
    expect(contrastRatio('red', '#fff')).toBe(1);
  });
});

describe('parseNumber', () => {
  it.each([
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['  -2 ', -2],
    ['.5', 0.5],
    ['1 000', 1000],
    ['', null],
  ])('%j -> %j', (text, expected) => expect(parseNumber(text)).toBe(expected));

  it.each(['abc', '1.2.3', '1,2,3', '12px', '--1', 'NaN', '1e5'])('rejects %j', (text) => expect(parseNumber(text)).toBeUndefined());
});

describe('date arithmetic', () => {
  it('counts whole days across month ends and DST changes', () => {
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('finds the next Monday strictly after a day', () => {
    expect(nextMondayISO('2026-06-15')).toBe('2026-06-22'); // Monday
    expect(nextMondayISO('2026-06-17')).toBe('2026-06-22'); // Wednesday
    expect(nextMondayISO('2026-06-21')).toBe('2026-06-22'); // Sunday
  });

  it('parses typed dates', () => {
    expect(parseDateText('2026-07-04', '2026-06-15')).toBe('2026-07-04');
    expect(parseDateText('4.7.2026', '2026-06-15')).toBe('2026-07-04');
    expect(parseDateText('4/7/2026', '2026-06-15')).toBe('2026-07-04');
    expect(parseDateText('4.7.', '2026-06-15')).toBe('2026-07-04');
    expect(parseDateText('Tomorrow', '2026-06-15')).toBe('2026-06-16');
    expect(parseDateText('', '2026-06-15')).toBeNull();
    expect(parseDateText('2026-02-30', '2026-06-15')).toBeUndefined();
    expect(parseDateText('31.4.2026', '2026-06-15')).toBeUndefined();
    expect(parseDateText('soon', '2026-06-15')).toBeUndefined();
  });

  it('describes dates relative to today', () => {
    expect(describeDate('2026-06-15', '2026-06-15')).toMatchObject({ kind: 'today', text: 'Today' });
    expect(describeDate('2026-06-16', '2026-06-15')).toMatchObject({ kind: 'tomorrow', text: 'Tomorrow' });
    expect(describeDate('2026-06-14', '2026-06-15')).toMatchObject({ kind: 'overdue', text: 'Yesterday' });
    expect(describeDate('2026-06-01', '2026-06-15')).toMatchObject({ kind: 'overdue', days: -14 });
    expect(describeDate('2026-06-30', '2026-06-15')).toMatchObject({ kind: 'future', days: 15 });
  });
});

describe('time zones never shift a date-only value', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  const expected = (y: number, m: number, d: number, withYear: boolean) =>
    new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(
      new Date(Date.UTC(y, m - 1, d, 12)),
    );

  for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata', 'UTC']) {
    it(`formats 2026-03-01 and 2026-12-31 unchanged in ${tz}`, () => {
      process.env.TZ = tz;
      expect(formatShortDate('2026-03-01', '2026-06-15')).toBe(expected(2026, 3, 1, false));
      expect(formatShortDate('2026-12-31', '2026-06-15')).toBe(expected(2026, 12, 31, false));
      expect(formatShortDate('2027-01-01', '2026-06-15')).toBe(expected(2027, 1, 1, true));
      expect(daysBetween('2026-03-01', '2026-03-02')).toBe(1);
      expect(describeDate('2026-03-01', '2026-03-01').kind).toBe('today');
    });

    it(`takes "today" from the local calendar day in ${tz}`, () => {
      process.env.TZ = tz;
      setCellClock(() => new Date(2026, 5, 15, 23, 59, 30)); // late evening local time
      expect(today()).toBe('2026-06-15');
      setCellClock(() => new Date(2026, 5, 15, 0, 0, 30)); // just after midnight local time
      expect(today()).toBe('2026-06-15');
    });
  }
});
