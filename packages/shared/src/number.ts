import Decimal from 'decimal.js';

/** Precision kinds from R19. */
export type RoundKind = 'weight' | 'TOMAN' | 'USD' | 'IQD' | 'percent' | 'g_per_m' | 'filler' | 'length';

export const CURRENCIES = ['TOMAN', 'USD', 'IQD'] as const;
export type Currency = (typeof CURRENCIES)[number];

const PLACES: Record<RoundKind, number> = {
  weight: 3,
  TOMAN: 0,
  USD: 2,
  IQD: 2,
  percent: 1,
  g_per_m: 1,
  filler: 2,
  length: 2,
};

export type DecimalInput = string | number | Decimal;

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export { D as Dec };
export type Dec = Decimal;

export function dec(value: DecimalInput): Decimal {
  return new D(value);
}

/** R19: half-up rounding to the fixed number of places for the kind. Returns a canonical decimal string. */
export function round(value: DecimalInput, kind: RoundKind): string {
  return new D(value).toDecimalPlaces(PLACES[kind], Decimal.ROUND_HALF_UP).toFixed(PLACES[kind]);
}

export function places(kind: RoundKind): number {
  return PLACES[kind];
}

/**
 * R19: percentage = part / whole × 100, rounded to 1 place.
 * Returns null (not shown) when the denominator is zero or either side is unknown.
 */
export function percent(part: DecimalInput | null, whole: DecimalInput | null): string | null {
  if (part === null || whole === null) return null;
  const w = new D(whole);
  if (w.isZero()) return null;
  return round(new D(part).div(w).mul(100), 'percent');
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(ch);
    out += a >= 0 ? String(a) : ch;
  }
  return out;
}

export function toPersianDigits(input: string): string {
  return input.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] ?? d);
}

/**
 * R20: accept Persian, Arabic and Latin digits; thousands separators «٬» and «,»;
 * decimal mark «٫» and «.». Returns a canonical decimal string, or null when the input is not a number.
 */
export function parseNumber(input: string): string | null {
  const s = toLatinDigits(input.trim())
    .replace(/[٬,\s‌‏‎]/g, '')
    .replace(/٫/g, '.')
    .replace(/^−/, '-');
  if (!/^-?\d+(\.\d+)?$/.test(s) && !/^-?\.\d+$/.test(s)) return null;
  return new D(s).toFixed();
}

/** Display a number with Persian digits, «٬» thousands separator and «٫» decimal mark, rounded per R19. */
export function formatNumber(value: DecimalInput | null, kind?: RoundKind): string | null {
  if (value === null) return null;
  const fixed = kind ? round(value, kind) : new D(value).toFixed();
  const negative = fixed.startsWith('-');
  const [intPart = '0', frac] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const body = frac ? `${grouped}٫${frac}` : grouped;
  return toPersianDigits((negative ? '-' : '') + body);
}

/** Canonical decimal string validators used by API schemas: money and weight travel as strings. */
export const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
