/**
 * R25: amount in words, Persian and Arabic, integers up to the trillions,
 * with «و» between parts and the currency name at the end.
 */
import type { Currency } from './number.js';

const FA_ONES = ['', 'یک', 'دو', 'سه', 'چهار', 'پنج', 'شش', 'هفت', 'هشت', 'نه'];
const FA_TEENS = ['ده', 'یازده', 'دوازده', 'سیزده', 'چهارده', 'پانزده', 'شانزده', 'هفده', 'هجده', 'نوزده'];
const FA_TENS = ['', '', 'بیست', 'سی', 'چهل', 'پنجاه', 'شصت', 'هفتاد', 'هشتاد', 'نود'];
const FA_HUNDREDS = ['', 'صد', 'دویست', 'سیصد', 'چهارصد', 'پانصد', 'ششصد', 'هفتصد', 'هشتصد', 'نهصد'];
const FA_SCALES = ['', 'هزار', 'میلیون', 'میلیارد', 'تریلیون'];

const FA_CURRENCY: Record<Currency, string> = { TOMAN: 'تومان', USD: 'دلار', IQD: 'دینار' };
const AR_CURRENCY: Record<Currency, string> = { TOMAN: 'تومان', USD: 'دولار', IQD: 'دينار' };

const MAX = 999_999_999_999_999n; // up to 999 trillion

function toBigInt(value: string | number | bigint): bigint {
  const s = String(value).trim();
  if (!/^\d+(\.0+)?$/.test(s)) throw new RangeError('مبلغ به حروف فقط برای عدد صحیح نامنفی است');
  const n = BigInt(s.split('.')[0] as string);
  if (n > MAX) throw new RangeError('مبلغ بیش از حد مجاز برای حروف');
  return n;
}

function groups(n: bigint): number[] {
  const out: number[] = [];
  let x = n;
  while (x > 0n) {
    out.push(Number(x % 1000n));
    x /= 1000n;
  }
  return out;
}

function faUnder1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(FA_HUNDREDS[h] as string);
  if (rest >= 10 && rest < 20) parts.push(FA_TEENS[rest - 10] as string);
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) parts.push(FA_TENS[t] as string);
    if (o) parts.push(FA_ONES[o] as string);
  }
  return parts.join(' و ');
}

export function numberToPersianWords(value: string | number | bigint): string {
  const n = toBigInt(value);
  if (n === 0n) return 'صفر';
  const g = groups(n);
  const parts: string[] = [];
  for (let i = g.length - 1; i >= 0; i -= 1) {
    const v = g[i] as number;
    if (!v) continue;
    const words = faUnder1000(v);
    parts.push(i === 0 ? words : `${words} ${FA_SCALES[i]}`);
  }
  return parts.join(' و ');
}

export function amountToPersianWords(value: string | number | bigint, currency: Currency = 'TOMAN'): string {
  return `${numberToPersianWords(value)} ${FA_CURRENCY[currency]}`;
}

const AR_ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'];
const AR_TEENS = [
  'عشرة',
  'أحد عشر',
  'اثنا عشر',
  'ثلاثة عشر',
  'أربعة عشر',
  'خمسة عشر',
  'ستة عشر',
  'سبعة عشر',
  'ثمانية عشر',
  'تسعة عشر',
];
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
/** [singular, dual, plural (3–10)] */
const AR_SCALES: Array<[string, string, string]> = [
  ['', '', ''],
  ['ألف', 'ألفان', 'آلاف'],
  ['مليون', 'مليونان', 'ملايين'],
  ['مليار', 'ملياران', 'مليارات'],
  ['تريليون', 'تريليونان', 'تريليونات'],
];

function arUnder1000(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(AR_HUNDREDS[h] as string);
  if (rest >= 10 && rest < 20) parts.push(AR_TEENS[rest - 10] as string);
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    // Arabic reads units before tens: «خمسة وعشرون»
    if (o) parts.push(AR_ONES[o] as string);
    if (t) parts.push(AR_TENS[t] as string);
  }
  return parts.join(' و ');
}

export function numberToArabicWords(value: string | number | bigint): string {
  const n = toBigInt(value);
  if (n === 0n) return 'صفر';
  const g = groups(n);
  const parts: string[] = [];
  for (let i = g.length - 1; i >= 0; i -= 1) {
    const v = g[i] as number;
    if (!v) continue;
    if (i === 0) {
      parts.push(arUnder1000(v));
      continue;
    }
    const [one, two, many] = AR_SCALES[i] as [string, string, string];
    if (v === 1) parts.push(one);
    else if (v === 2) parts.push(two);
    else if (v <= 10) parts.push(`${arUnder1000(v)} ${many}`);
    else parts.push(`${arUnder1000(v)} ${one}`);
  }
  return parts.join(' و ');
}

export function amountToArabicWords(value: string | number | bigint, currency: Currency = 'TOMAN'): string {
  return `${numberToArabicWords(value)} ${AR_CURRENCY[currency]}`;
}
