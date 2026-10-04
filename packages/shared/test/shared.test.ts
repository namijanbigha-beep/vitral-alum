import { describe, expect, it } from 'vitest';
import {
  amountToArabicWords,
  amountToPersianWords,
  formatNumber,
  parseJalali,
  parseNumber,
  percent,
  round,
  toGregorian,
  toJalali,
  isValidJalali,
} from '../src/index.js';

describe('T30, T31 — R25 amount in words', () => {
  it('T30: 911,125,750', () => {
    expect(amountToPersianWords('911125750')).toBe(
      'نهصد و یازده میلیون و صد و بیست و پنج هزار و هفتصد و پنجاه تومان',
    );
  });
  it('T31: 375,000,000 and 0', () => {
    expect(amountToPersianWords(375000000)).toBe('سیصد و هفتاد و پنج میلیون تومان');
    expect(amountToPersianWords(0)).toBe('صفر تومان');
  });
  it('handles trillions and the other currencies', () => {
    expect(amountToPersianWords('1000000000000', 'USD')).toBe('یک تریلیون دلار');
    expect(amountToPersianWords('2016', 'IQD')).toBe('دو هزار و شانزده دینار');
  });
  it('Arabic uses the same numbers', () => {
    expect(amountToArabicWords('911125750')).toBe(
      'تسعمائة و أحد عشر مليون و مائة و خمسة و عشرون ألف و سبعمائة و خمسون تومان',
    );
    expect(amountToArabicWords(0, 'USD')).toBe('صفر دولار');
    expect(amountToArabicWords(3000, 'IQD')).toBe('ثلاثة آلاف دينار');
  });
  it('rejects fractions and negatives', () => {
    expect(() => amountToPersianWords('12.5')).toThrow();
    expect(() => amountToPersianWords('-1')).toThrow();
  });
});

describe('T32 — R20 number input', () => {
  it('reads Persian, Latin and Arabic forms identically', () => {
    expect(parseNumber('۱٬۲۳۴٫۵')).toBe('1234.5');
    expect(parseNumber('1,234.5')).toBe('1234.5');
    expect(parseNumber('١٢٣٤٫٥')).toBe('1234.5');
  });
  it('rejects garbage', () => {
    expect(parseNumber('12a')).toBeNull();
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('1.2.3')).toBeNull();
  });
});

describe('R19 rounding and display', () => {
  it('rounds half-up per kind', () => {
    expect(round('4.7465', 'weight')).toBe('4.747');
    expect(round('1234.5', 'TOMAN')).toBe('1235');
    expect(round('10.005', 'USD')).toBe('10.01');
    expect(round('791.15', 'g_per_m')).toBe('791.2');
  });
  it('percent with zero or null denominator is not shown', () => {
    expect(percent(5, 0)).toBeNull();
    expect(percent(5, null)).toBeNull();
    expect(percent(5, 1000)).toBe('0.5');
  });
  it('formats with Persian digits and separators', () => {
    expect(formatNumber('911125750', 'TOMAN')).toBe('۹۱۱٬۱۲۵٬۷۵۰');
    expect(formatNumber('977.795', 'weight')).toBe('۹۷۷٫۷۹۵');
    expect(formatNumber(null)).toBeNull();
  });
});

describe('T33 — R26 Jalali dates', () => {
  it('1405/06/23 is valid and round-trips', () => {
    const j = parseJalali('۱۴۰۵/۰۶/۲۳');
    expect(j).toEqual({ jy: 1405, jm: 6, jd: 23 });
    const g = toGregorian(1405, 6, 23);
    expect(g).toEqual({ gy: 2026, gm: 9, gd: 14 });
    expect(toJalali(g.gy, g.gm, g.gd)).toEqual({ jy: 1405, jm: 6, jd: 23 });
  });
  it('1405/07/00 is rejected', () => {
    expect(parseJalali('1405/07/00')).toBeNull();
  });
  it('1404/12/30 is rejected (1404 is not leap)', () => {
    expect(parseJalali('1404/12/30')).toBeNull();
    expect(isValidJalali(1404, 12, 29)).toBe(true);
  });
  it('1403/12/30 is valid (1403 is leap)', () => {
    expect(parseJalali('1403/12/30')).toEqual({ jy: 1403, jm: 12, jd: 30 });
    expect(toGregorian(1403, 12, 30)).toEqual({ gy: 2025, gm: 3, gd: 20 });
  });
  it('accepts eight typed digits', () => {
    expect(parseJalali('14050603')).toEqual({ jy: 1405, jm: 6, jd: 3 });
  });
  it('round-trips every day over several years', () => {
    for (let jy = 1395; jy <= 1415; jy += 1) {
      for (let jm = 1; jm <= 12; jm += 1) {
        for (let jd = 1; jd <= 31; jd += 1) {
          if (!isValidJalali(jy, jm, jd)) continue;
          const g = toGregorian(jy, jm, jd);
          expect(toJalali(g.gy, g.gm, g.gd)).toEqual({ jy, jm, jd });
        }
      }
    }
  });
});
