/**
 * Generates tests/fixtures/money-rules.json from apps/server/src/rules/money.ts, so the PHP port (src/Rules/Money.php)
 * is checked against the exact Node outputs. Each case is [function, args, result] or [function, args, {error}].
 *
 *   cd apps/server && node --import tsx ../php/tests/fixtures/generate-money.ts
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../../../server/src/rules/money.js';

let seed = 20261005;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
const CUR = ['TOMAN', 'USD', 'IQD'] as const;
const dec = (maxInt: number, dp: number): string => {
  const i = Math.floor(rnd() * maxInt);
  if (dp === 0 || rnd() < 0.2) return String(i);
  const f = String(Math.floor(rnd() * 10 ** dp)).padStart(dp, '0');
  return `${i}.${f}`;
};
const KINDS = ['invoice', 'sales_return', 'purchase', 'toll_fee', 'expense', 'receipt', 'payment', 'barter', 'opening_balance', 'fx_difference'] as const;

const cases: Array<[string, unknown[], unknown]> = [];
const run = (name: string, args: unknown[]): void => {
  const fn = (M as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!;
  try {
    cases.push([name, args, fn(...args)]);
  } catch (e) {
    cases.push([name, args, { error: (e as Error).message }]);
  }
};

for (const v of ['0.5', '1.005', '-2.5', '1234.555', '0', '-0.004']) for (const c of CUR) run('moneyRound', [v, c]);
for (let i = 0; i < 80; i++) {
  run('lineAmount', [rnd() < 0.1 ? null : dec(5000, 3), rnd() < 0.1 ? null : dec(900000, 2), pick(CUR), dec(1000, 2), dec(100, 2)]);
}
run('lineAmount', ['10', '3', 'USD']);
for (let i = 0; i < 20; i++) {
  const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({ amount: rnd() < 0.15 ? null : dec(100000, 2), currency: pick(CUR) }));
  run('totalsByCurrency', [lines]);
}
run('totalsByCurrency', [[]]);
for (let i = 0; i < 30; i++) run('prepayment', [dec(10000000, 2), dec(100, 2), dec(5000000, 2), pick(CUR)]);
for (let i = 0; i < 20; i++) {
  const docs = Array.from({ length: Math.floor(rnd() * 8) }, () => ({ kind: pick(KINDS), amount: (rnd() < 0.2 ? '-' : '') + dec(100000, 2), currency: pick(CUR), status: pick(['posted', 'posted', 'draft', 'void']) }));
  run('partyBalance', [docs]);
}
run('emptyAvg', []);
for (let i = 0; i < 20; i++) {
  let st: M.AvgState = M.emptyAvg();
  for (let k = 0; k < 4; k++) {
    if (rnd() < 0.6) {
      const args = [st, dec(5000, 3), rnd() < 0.1 ? null : dec(400000, 2), pick(CUR)];
      run('applyReceipt', args);
      st = M.applyReceipt(...(args as [M.AvgState, string, string | null, 'TOMAN']));
    } else {
      const args = [st, dec(1000, 3)];
      run('applyIssue', args);
      const r = M.applyIssue(...(args as [M.AvgState, string]));
      st = { kg: r.kg, value: r.value, avg: r.avg, incomplete: r.incomplete };
    }
  }
}
run('applyIssue', [{ kg: '0.000', value: '0', avg: null, incomplete: false }, '5']);
for (let i = 0; i < 20; i++) run('realisedProfit', [dec(90000000, 2), rnd() < 0.1 ? null : dec(80000000, 2), dec(5000, 3), rnd() < 0.1 ? '0' : dec(9000, 3), pick(CUR)]);
for (let i = 0; i < 20; i++) run('profitSplit', [(rnd() < 0.3 ? '-' : '') + dec(9000000, 2), dec(200, 3), dec(400000, 2), pick(CUR)]);
for (let i = 0; i < 30; i++) {
  const n = Math.floor(rnd() * 5);
  run('splitByWeight', [dec(10000000, 2), Array.from({ length: n }, () => (rnd() < 0.1 ? '0' : dec(3000, 3))), pick(CUR)]);
}
run('splitByWeight', ['100', ['0', '0'], 'TOMAN']);
run('splitByWeight', ['100', ['1', '1', '1'], 'TOMAN']);
run('splitByWeight', ['100', ['1', '1', '1'], 'USD']);
for (let i = 0; i < 20; i++) run('suggestedPricePerKg', [rnd() < 0.1 ? null : dec(90000000, 2), rnd() < 0.1 ? '0' : dec(9000, 3), dec(60, 1), pick(CUR)]);
for (let i = 0; i < 30; i++) {
  const pay = pick(CUR);
  const debt = pick(CUR);
  const dir = rnd();
  const [from, to] = dir < 0.45 ? [debt, pay] : dir < 0.9 ? [pay, debt] : [pick(CUR), pick(CUR)];
  run('crossCurrencySettlement', [dec(100000, 2), pay, debt, dec(90000, 6), from, to]);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'money-rules.json');
writeFileSync(out, JSON.stringify({ cases }, null, 1) + '\n');
console.log(`wrote ${cases.length} cases to ${out}`);
