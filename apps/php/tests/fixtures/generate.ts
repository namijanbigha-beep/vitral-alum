/**
 * Generates tests/fixtures/shared.json from the TypeScript originals in packages/shared, so the PHP ports
 * (Decimal, Num, Jalali, Words, numbering) are checked against the exact Node outputs.
 *
 *   cd apps/server && node --import tsx ../php/tests/fixtures/generate.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Dec,
  amountToArabicWords,
  amountToPersianWords,
  formatJalali,
  formatNumber,
  isJalaliLeapYear,
  jalaliOf,
  numberToArabicWords,
  numberToPersianWords,
  parseJalali,
  parseNumber,
  percent,
  round,
  toGregorian,
  toJalali,
  type RoundKind,
} from '../../../../packages/shared/src/index.js';
import { renderPattern, counterPeriod } from '../../../server/src/lib/numbering.js';

let seed = 20261005;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const int = (n: number): number => Math.floor(rnd() * n);

function randDecimal(): string {
  const digits = 1 + int(int(3) === 0 ? 30 : 9);
  let s = String(1 + int(9));
  for (let i = 1; i < digits; i += 1) s += String(int(10));
  const scale = int(4) === 0 ? 0 : int(int(4) === 0 ? 25 : 5);
  if (scale > 0 && scale < s.length) s = `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
  else if (scale >= s.length) s = `0.${'0'.repeat(scale - s.length)}${s}`;
  if (int(5) === 0) s = '0.' + '0'.repeat(int(4)) + String(int(10)) + '5';
  if (int(3) === 0) s = `-${s}`;
  return s;
}

const special = ['0', '-0', '1', '-1', '0.5', '-0.5', '2.5', '-2.5', '0.0005', '-0.0004', '999.9995', '1e3', '1.5e-3', '123.456', '-0.05', '0.045', '1000000000000000000000.5'];
const decimals = [...special];
for (let i = 0; i < 300; i += 1) decimals.push(randDecimal());

const decimalOps: unknown[] = [];
for (let i = 0; i < decimals.length; i += 1) {
  const a = decimals[i] as string;
  const b = decimals[(i * 7 + 3) % decimals.length] as string;
  const row: Record<string, unknown> = {
    a,
    b,
    a_fixed: new Dec(a).toFixed(),
    add: new Dec(a).add(b).toFixed(),
    sub: new Dec(a).sub(b).toFixed(),
    mul: new Dec(a).mul(b).toFixed(),
    div: new Dec(b).isZero() ? null : new Dec(a).div(b).toFixed(),
    cmp: new Dec(a).cmp(b),
    fixed: [0, 1, 2, 3].map((dp) => new Dec(a).toFixed(dp)),
  };
  decimalOps.push(row);
}

const kinds: RoundKind[] = ['weight', 'TOMAN', 'USD', 'IQD', 'percent', 'g_per_m', 'filler', 'length'];
const rounds = decimals.flatMap((v) => kinds.map((k) => ({ v, k, r: round(v, k) })));
const percents = decimals.slice(0, 120).map((v, i) => {
  const w = decimals[(i * 13 + 5) % decimals.length] as string;
  return { part: v, whole: w, r: percent(v, w) };
});
percents.push({ part: '5', whole: '0', r: percent('5', '0') });

const numberInputs = ['۱۲۳٬۴۵۶٫۷۸', '١٢٣,٤٥٦.٧٨', ' 12,345 ', '−5', '-.5', '.5', '1.', 'abc', '', '۰۰۱۲', '1 000', '12‌345', '1e3', '+5', '٫۵', '-0', '0.000', '12.50'];
const parsed = numberInputs.map((s) => ({ s, r: parseNumber(s) }));
const formatted = decimals.slice(0, 150).flatMap((v) => [{ v, k: null, r: formatNumber(v) }, { v, k: 'weight', r: formatNumber(v, 'weight') }, { v, k: 'TOMAN', r: formatNumber(v, 'TOMAN') }]);

const jalali: unknown[] = [];
for (let i = 0; i < 400; i += 1) {
  const t = Date.UTC(1990, 0, 1) + Math.floor(rnd() * 60 * 365.25) * 86_400_000;
  const d = new Date(t);
  const j = toJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  jalali.push({ g: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()], j: [j.jy, j.jm, j.jd], back: Object.values(toGregorian(j.jy, j.jm, j.jd)) });
}
const leaps = Array.from({ length: 120 }, (_, i) => ({ y: 1350 + i, leap: isJalaliLeapYear(1350 + i) }));
const parseJ = ['۱۴۰۵/۰۶/۲۳', '14050623', '1405-6-3', '1403/12/30', '1404/12/30', '1405/13/01', '1405/07/31', 'x', ' ١٤٠٥.٠٧.١٠ '].map((s) => ({ s, r: parseJalali(s) ? formatJalali(parseJalali(s)!) : null }));
const instants: unknown[] = [];
for (let i = 0; i < 200; i += 1) {
  const at = new Date(Date.UTC(2020, 0, 1) + Math.floor(rnd() * 10 * 365 * 86_400_000));
  const j = jalaliOf(at);
  instants.push({ at: at.toISOString(), j: formatJalali(j), utc: formatJalali(jalaliOf(at, 'UTC')) });
}

const wordNums = ['0', '1', '7', '10', '11', '19', '20', '21', '99', '100', '101', '110', '111', '200', '999', '1000', '1001', '1010', '2000', '2500', '10000', '11000', '100000', '101101', '1000000', '2000000', '3000000', '12345678', '1000000000', '2000000000', '1000000000000', '999999999999999', '123456789012345', '5.00'];
for (let i = 0; i < 150; i += 1) wordNums.push(String(Math.floor(rnd() * 10 ** (1 + int(14)))));
const words = wordNums.map((n) => ({
  n,
  fa: numberToPersianWords(n),
  ar: numberToArabicWords(n),
  faUsd: amountToPersianWords(n, 'USD'),
  arIqd: amountToArabicWords(n, 'IQD'),
  faToman: amountToPersianWords(n),
}));

const patterns = ['VT-{seq:4}', 'V{yymmdd}-{seq}', 'INV-{yyyy}/{mm}/{dd}-{seq:3}', 'X{yy}{seq:2}', 'P-{seq}'];
const numbering = instants.slice(0, 40).flatMap((x, i) =>
  patterns.map((p) => {
    const at = new Date((x as { at: string }).at);
    return { p, seq: i + 1, at: (x as { at: string }).at, r: renderPattern(p, i + 1, at, 'Asia/Tehran'), period: counterPeriod(p, at, 'Asia/Tehran') };
  }),
);

const out = { decimalOps, rounds, percents, parsed, formatted, jalali, leaps, parseJ, instants, words, numbering };
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shared.json');
writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}`);
