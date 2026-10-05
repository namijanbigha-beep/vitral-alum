import { formatJalali, jalaliOf, parseJalali, toGregorian, type JalaliDate } from '@vitral/shared';

/** Tehran has had no DST since 2022: a fixed +03:30. Business days are Tehran days. */
export const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

/** Tehran calendar date (YYYY-MM-DD) of an instant: what a DATE column holds for that business day. */
export const tehranDateKey = (at: Date): string => new Date(at.getTime() + TEHRAN_OFFSET_MS).toISOString().slice(0, 10);

/** [start, end) UTC instants of a Jalali business day. */
export function jalaliDayRange(d: JalaliDate): { start: Date; end: Date } {
  const g = toGregorian(d.jy, d.jm, d.jd);
  const start = new Date(Date.UTC(g.gy, g.gm - 1, g.gd) - TEHRAN_OFFSET_MS);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Parse «1405/07/10» (any digits) or default to today's Jalali date in Tehran. */
export function jalaliDateArg(input: string | undefined, at: Date = new Date()): JalaliDate {
  if (!input) return jalaliOf(at);
  const j = parseJalali(input);
  if (!j) throw new RangeError('تاریخ شمسی نامعتبر است');
  return j;
}

export const jalaliKey = (d: JalaliDate): string => formatJalali(d);

/** Gregorian date-only (UTC midnight) used as the unique key in daily_reports. */
export function jalaliToDateKey(d: JalaliDate): Date {
  const g = toGregorian(d.jy, d.jm, d.jd);
  return new Date(Date.UTC(g.gy, g.gm - 1, g.gd));
}
