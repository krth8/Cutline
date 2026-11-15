import { afterAll, describe, expect, it } from 'vitest';
import {
  addDays,
  dayIndexToYmd,
  daysInMonth,
  diffDays,
  fromDayIndex,
  mondayOnOrBefore,
  monthStartIndex,
  parseYmd,
  toDayIndex,
  todayString,
  weekdayOfIndex,
  yearStartIndex,
} from './dates';

describe('parseYmd', () => {
  it('accepts real calendar days only', () => {
    expect(parseYmd('2030-01-31')).toEqual({ y: 2030, m: 1, d: 31 });
    expect(parseYmd('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 });
    for (const bad of ['2023-02-29', '2030-13-01', '2030-00-10', '2030-04-31', '2030-1-1', '20300101', '2030-01-01T00:00', '', null, 5]) {
      expect(parseYmd(bad)).toBeNull();
    }
  });
  it('knows the month lengths', () => {
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2030, 12)).toBe(31);
  });
});

describe('day index', () => {
  it('counts days since 1970-01-01', () => {
    expect(toDayIndex('1970-01-01')).toBe(0);
    expect(toDayIndex('1970-01-02')).toBe(1);
    expect(toDayIndex('1969-12-31')).toBe(-1);
    expect(toDayIndex('2000-03-01')).toBe(11017);
    expect(toDayIndex('2030-01-01')).toBe(21915);
    expect(toDayIndex('nonsense')).toBeNull();
  });
  it('round-trips every day over several years, including leap days and the epoch', () => {
    const start = toDayIndex('1996-01-01') as number;
    const end = toDayIndex('2105-12-31') as number;
    for (let n = start; n <= end; n++) expect(toDayIndex(fromDayIndex(n))).toBe(n);
    expect(fromDayIndex(toDayIndex('2024-02-29') as number)).toBe('2024-02-29');
  });
  it('adds and subtracts days across month and year borders', () => {
    expect(addDays('2030-01-31', 1)).toBe('2030-02-01');
    expect(addDays('2030-01-01', -1)).toBe('2029-12-31');
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2030-03-30', 3)).toBe('2030-04-02');
    expect(addDays('bad', 1)).toBeNull();
    expect(diffDays('2030-01-01', '2030-03-01')).toBe(59);
    expect(diffDays('2030-03-01', '2030-01-01')).toBe(-59);
  });
  it('gets weekdays right (0 = Sunday)', () => {
    expect(weekdayOfIndex(toDayIndex('1970-01-01') as number)).toBe(4);
    expect(weekdayOfIndex(toDayIndex('2030-01-05') as number)).toBe(6); // a Saturday
    expect(weekdayOfIndex(toDayIndex('2030-01-06') as number)).toBe(0);
    expect(weekdayOfIndex(toDayIndex('1969-12-28') as number)).toBe(0);
  });
  it('finds month, year and week starts', () => {
    const n = toDayIndex('2030-03-17') as number;
    expect(fromDayIndex(monthStartIndex(n))).toBe('2030-03-01');
    expect(fromDayIndex(monthStartIndex(n, -3))).toBe('2029-12-01');
    expect(fromDayIndex(monthStartIndex(n, 10))).toBe('2031-01-01');
    expect(fromDayIndex(yearStartIndex(n))).toBe('2030-01-01');
    expect(fromDayIndex(yearStartIndex(n, 1))).toBe('2031-01-01');
    expect(fromDayIndex(mondayOnOrBefore(toDayIndex('2030-01-06') as number))).toBe('2029-12-31');
    expect(fromDayIndex(mondayOnOrBefore(toDayIndex('2030-01-07') as number))).toBe('2030-01-07');
    expect(dayIndexToYmd(toDayIndex('2030-02-14') as number)).toEqual({ y: 2030, m: 2, d: 14 });
  });
});

describe('todayString', () => {
  it('formats the local calendar day', () => {
    expect(todayString(new Date(2030, 0, 5, 23, 59, 59))).toBe('2030-01-05');
    expect(todayString(new Date(2030, 0, 5, 0, 0, 1))).toBe('2030-01-05');
    expect(todayString(new Date(2029, 11, 31, 12))).toBe('2029-12-31');
  });
});

declare const process: { env: Record<string, string | undefined> };

describe('time zones', () => {
  const original = process.env.TZ;
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // The helpers only use year/month/day numbers, so the result is the same west and east of UTC
  for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland', 'Pacific/Kiritimati']) {
    it(`gives the same days with TZ=${tz}`, () => {
      process.env.TZ = tz;
      expect(toDayIndex('2030-03-31')).toBe(22004);
      expect(fromDayIndex(22004)).toBe('2030-03-31');
      expect(addDays('2030-03-30', 2)).toBe('2030-04-01'); // a DST change in many zones
      expect(addDays('2030-10-26', 2)).toBe('2030-10-28');
      expect(diffDays('2030-01-01', '2031-01-01')).toBe(365);
      expect(weekdayOfIndex(toDayIndex('2030-01-05') as number)).toBe(6);
      expect(todayString(new Date(2030, 5, 15, 0, 30))).toBe('2030-06-15');
      expect(todayString(new Date(2030, 5, 15, 23, 30))).toBe('2030-06-15');
    });
  }
});
