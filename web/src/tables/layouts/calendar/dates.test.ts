import { afterEach, describe, expect, it } from 'vitest';
import { addDays, addMonths, diffDays, monthGrid, normalizeYmd, parseYmd, startOfMonth, startOfWeek, todayYmd, weekOf, weekTitle, weekdayIndex } from './dates';

// The machine's time zone is changed through the Node environment (no Node types in the bundle's tsconfig)
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const originalTz = env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete env.TZ;
  else env.TZ = originalTz;
});

describe('calendar dates', () => {
  it('parses real days only', () => {
    expect(parseYmd('2026-02-28')).toEqual({ y: 2026, m: 2, d: 28 });
    expect(parseYmd('2026-02-29')).toBeNull();
    expect(parseYmd('2028-02-29')).toEqual({ y: 2028, m: 2, d: 29 });
    expect(parseYmd('2026-13-01')).toBeNull();
    expect(parseYmd('nope')).toBeNull();
    expect(parseYmd(null)).toBeNull();
    expect(normalizeYmd('2026-06-20T23:30:00')).toBe('2026-06-20');
  });

  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-06-15', 0)).toBe('2026-06-15');
    expect(addDays('2026-06-15', 400)).toBe('2027-07-20');
    expect(addDays('1999-12-31', 1)).toBe('2000-01-01');
  });

  it('counts the days between two days', () => {
    expect(diffDays('2026-06-01', '2026-06-08')).toBe(7);
    expect(diffDays('2026-06-08', '2026-06-01')).toBe(-7);
    expect(diffDays('2026-12-31', '2027-01-01')).toBe(1);
    expect(diffDays('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('knows the weekday (Monday first)', () => {
    expect(weekdayIndex('2026-11-16')).toBe(0); // Monday
    expect(weekdayIndex('2026-11-15')).toBe(6); // Sunday
    expect(weekdayIndex('1970-01-01')).toBe(3); // Thursday
    expect(weekdayIndex('1969-12-31')).toBe(2); // Wednesday
    expect(startOfWeek('2026-11-15')).toBe('2026-11-09');
    expect(startOfWeek('2026-11-16')).toBe('2026-11-16');
    expect(weekOf('2026-11-09')).toEqual(['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  });

  it('moves by months and clamps the day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
    expect(addMonths('2026-03-31', -13)).toBe('2025-02-28');
    expect(startOfMonth('2026-11-15')).toBe('2026-11-01');
  });

  it('builds the month grid with Monday-first weeks', () => {
    const nov = monthGrid('2026-11-15'); // 1 Nov 2026 is a Sunday
    expect(nov).toHaveLength(6);
    expect(nov[0]![0]).toBe('2026-10-26');
    expect(nov[0]![6]).toBe('2026-11-01');
    expect(nov[5]![6]).toBe('2026-12-06');
    const feb = monthGrid('2027-02-10'); // 1 Feb 2027 is a Monday, 28 days: exactly four weeks
    expect(feb).toHaveLength(4);
    expect(feb[0]![0]).toBe('2027-02-01');
    expect(feb[3]![6]).toBe('2027-02-28');
    for (const week of monthGrid('2026-05-01')) expect(week).toHaveLength(7);
  });

  it('titles a week across months and years', () => {
    expect(weekTitle('2026-11-09')).toBe('9 - 15 Nov 2026');
    expect(weekTitle('2026-11-30')).toBe('30 Nov - 6 Dec 2026');
    expect(weekTitle('2026-12-28')).toBe('28 Dec 2026 - 3 Jan 2027');
  });

  it('reads today from the local fields', () => {
    expect(todayYmd(new Date(2026, 2, 29, 0, 30))).toBe('2026-03-29');
    expect(todayYmd(new Date(2026, 10, 15, 23, 59))).toBe('2026-11-15');
  });

  // Same answers whatever the machine's offset is (west of UTC, east of UTC, around daylight saving changes)
  for (const tz of ['America/Los_Angeles', 'Pacific/Auckland', 'Europe/Berlin', 'UTC', 'Pacific/Kiritimati']) {
    it(`never shifts a day in ${tz}`, () => {
      env.TZ = tz;
      expect(addDays('2026-03-08', 1)).toBe('2026-03-09'); // US spring forward
      expect(addDays('2026-03-28', 1)).toBe('2026-03-29'); // EU spring forward day
      expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
      expect(addDays('2026-10-25', 1)).toBe('2026-10-26'); // EU fall back
      expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // US fall back
      expect(addDays('2026-09-27', 1)).toBe('2026-09-28'); // NZ spring forward
      expect(diffDays('2026-03-28', '2026-03-30')).toBe(2);
      expect(diffDays('2026-10-24', '2026-10-27')).toBe(3);
      expect(weekOf('2026-03-23').slice(-1)[0]).toBe('2026-03-29');
      expect(weekdayIndex('2026-03-29')).toBe(6);
      expect(monthGrid('2026-03-10')[5]![6]).toBe('2026-04-05');
      expect(normalizeYmd('2026-06-20')).toBe('2026-06-20');
      expect(todayYmd(new Date(2026, 5, 20, 0, 5))).toBe('2026-06-20');
      expect(todayYmd(new Date(2026, 5, 20, 23, 55))).toBe('2026-06-20');
    });
  }
});
